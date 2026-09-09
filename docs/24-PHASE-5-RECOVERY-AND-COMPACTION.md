# Phase 5 — Recovery + Compaction + Steering

> 状态: **范围已定,决策已拍**。本文件记录 Phase 5 边界、当前代码现状、PM 拍板的设计决策,以及动工前需要进一步收敛的边界 case。

> 决策记录见 [§7](#7-决策记录)。

---

## 1. 范围(已定)

来源:`ROADMAP.md#6`。Phase 5 由三件事组成:

| 事项 | 入口 | 目标行为 |
|---|---|---|
| **Recovery** | `POST /sessions/:id/resume` + UI Resume 按钮 | 进程崩溃/手动 abort 后,Session 可从 event-log 末尾重建,继续往下跑 |
| **Compaction** | `prepareNextTurn` 钩子 + 触发策略 | 长会话超 token 阈值时,由 Pi 内置 compression 压缩历史,UI 显示状态 |
| **Steering** | 已在 Phase 2 完成 | `getSteeringMessages` + `POST /sessions/:id/steer` 已接好,本次不动 |

Steering 已在 Phase 2(`db39b9c`)实现,本次只做前两件。

---

## 2. 当前现状(代码事实)

### 2.1 Recovery(0 / 5)

- `session-manager.ts` 只有 `create / steer / abort / get / list / delete` — **没有 `resume()`**
- `runtime-supervisor.ts` 31 行,沿用旧 task-* 命名(`POST /tasks/${taskId}/resume`),**整个模块未被接入新 Session 模型,等于死代码**
- `agent-runner.ts` 103 行,stream 退出时 `session.messages = await stream.result()`,但未自动落盘
- `event-log.ts` 的 FIFO append 队列保证顺序;但 `replaySession(id)` 从未实现

### 2.2 Compaction(2 / 5)

- `transform-context.ts` 35 行 — 字符级粗估 + LastN 截断(注释里已写"Phase 5 替换")
- Pi 已 vendored(`115e5f5`),`packages/coding-agent/src/core/compaction/compaction.ts` 750 行成熟实现 + `agent-session-compaction.test.ts` 264 行测试可参考
- `agent-runner.ts:64` 只挂了 `transformContext`,未挂 `prepareNextTurn`(钩子位置空着)
- `Pi AgentLoopConfig` 已声明 `prepareNextTurn?: (turn: PrepareNextTurnContext, signal?: AbortSignal) => Promise<void>`,见 `pi/packages/agent/src/types.ts:230`

### 2.3 UI(0 / 5)

- `desktop/src/` grep `resume|recovery|restart` **零命中**
- `SessionView` 已有 SESSION_ENDED/FAILED 渲染路径,需加 "Resume" 按钮

---

## 3. 需要拍板的决策

下面三件事不复杂,但语义边界一旦敲错,后面改起来很贵。开工前必须定。

---

### 决策 D1:Resume 语义

**问题**:用户点 Resume 时,Session 该怎么延续?

| 选项 | 含义 | 适用场景 |
|---|---|---|
| **A. 续上次跑**(推荐) | 把已落盘的 messages 喂回 agentLoop,**不追加新 goal**,agent 看到自己的对话历史接着往下做 | 崩溃恢复、补一句"再跑一下剩下的" |
| B. 重跑同样 goal | 清空 messages,把 SESSION_CREATED 时的 goal 重新发一遍 | 试错场景,但等于"重做" |
| C. UI 二选一 | Resume 按钮弹两个选项 | 体验最完整,实现成本翻倍 |

**推荐 A 的理由**:
- `event-log` 已是 source of truth,replay 比"再造一个新 session"信息损失少
- 工具结果/中间状态都已落盘,不需要重新执行
- UI 上把"Continue from where you stopped"作为默认行为,符合用户对 Resume 一词的心智模型

**风险**:若 SESSION 跑了一半 LLM 在 stream 工具结果时被 abort,某些 toolResult 可能不完整 — 需要在 replay 时校验 message_end 配对,缺尾的丢弃。

**PM 拍板**:选项 A,补充边界 case — Resume 时允许**可选的 steering message**:
- `POST /sessions/:id/resume` body 可选字段 `message?: string`
- 如果有,注入 `steeringQueue`(同 `steer` 接口的语义),agent 续跑后第一件事就是处理这条
- 如果没有,纯续跑
- 典型场景:"接着跑,顺便把测试也修了" — 用户不需要 abort 再 resume+steer 两步

---

### 决策 D2:可 Resume 的 Session 状态白名单

**问题**:哪些 SessionStatus 的 session 可以被 resume?

当前 `SessionStatus` 取值:`running | completed | failed | cancelled`(待确认)。

| 选项 | 含义 |
|---|---|
| **A. 只允许 `failed` / `cancelled`**(推荐) | 干净的语义边界:session 主动结束后才能 resume |
| B. 允许 `completed` | 等于"重跑一遍成功任务",用途少 |
| C. `running` 也允许 resume(强制重建) | 高风险 — 意味着两次 agentLoop 同 sessionId,event-log 会双写 |

**推荐 A 的理由**:
- `running` 的 session 一定在 `this.active` 里,resume 路径走不通(无 messages 落盘差异)
- 语义清晰,UI 可用 status 直接控制按钮显隐
- "completed 不能 resume" 可以未来加(用户呼声高),但本次不做

**待 PM 确认**:是否包含 `cancelled`?我倾向包含 — 用户主动中止就是想"先停,稍后接着",最常见的 resume 场景。

**PM 拍板**:选项 A,`failed` + `cancelled` 都在内。`completed` 暂不做。

---

### 决策 D3:压缩触发策略

**问题**:什么时候触发 `prepareNextTurn`?

| 选项 | 触发条件 | 数据来源 |
|---|---|---|
| **A. 按真实 token 数自动**(推荐) | 每次 turn 末检查**最后一轮** `usage.inputTokens` 超过阈值(默认 120K) | `CostGuard` 已在 `message_end` 收集 usage,取最近一次即可 |
| B. 按 turn 数 | assistant turn > N 触发 | 简单但粗 — 不区分长 turn / 短 turn |
| C. 手动 | Settings 给用户开关 | 用户控制感强但暴露了不该暴露的旋钮 |

**推荐 A 的理由**:
- `costGuard` 已经在 `message_end` 收集 usage(见 `agent-runner.ts:87-97`),数据是权威的(provider 报的实际值,不是字符估算)
- 不需要新依赖
- 阈值可以放 ForgeConfig,未来给高级用户调

**⚠️ 自我更正(Anvil 反思)**:初稿写的是"累计 usage.inputTokens 超过阈值",**这是错的**。累计会把各 turn 重复算进去,但 context window 占用看的是当前轮 LLM 看到的 context 大小,**不是历史总和**。

正确做法:
- 取**最后一次** `message_end` 的 `usage.inputTokens`(provider 报的实际 context 大小)
- `CostGuard` 已有 `trackUsage()`,加 `getLastInputTokens()` 直接读最新一条
- 阈值默认 **120K**(200K context window 的 60%)— Pi 的 compaction 需要预留空间生成摘要,60% 留出余量是安全的

**待 PM 确认**:
- 阈值默认多少?(我建议 100K input tokens,匹配主流模型 context window 的 60-80%)
- 是否需要硬上限?超过某个值强制截断而不是只压缩(防止 OOM / 极端长 turn)

**PM 拍板**:选项 A + 取最后一轮 `inputTokens` + 默认 120K 阈值。硬上限本次不做(留未来)。

---

## 4. 决策敲定后的实现计划

### 4.1 Recovery 核心

**`src/core/persistence/replay.ts`**(新文件)
- `replaySession(id): Promise<AgentMessage[]>`
- **只** 从 `MESSAGE_STARTED` / `MESSAGE_ENDED` 事件对重建 `AgentMessage[]`
- **忽略**其他事件类型:`STUCK_WARNING` / `COST_UPDATE` / `GUARD_BLOCKED` / `VERIFICATION_RESULT` / `STEERING_QUEUED` / `SESSION_*` 都是审计/状态用,**不是 messages 的事实来源**
- 配对校验:`message_end` 之前必须有 `message_start` 匹配(同 `messageId`),缺尾的丢弃并发 `REPLAY_REPAIRED` 事件

**`src/server/session-manager.ts`**
- 新增 `resume(id, opts?: { message?: string }): Promise<{ sessionId: string }>`
- 校验 `status ∈ {failed, cancelled}` — 不在白名单返回 409
- 校验 `id` 不在 `this.active` 中(防止双写) — 命中返回 409
- 调 `replaySession(id)` 拿到 messages → 加载 session(读取 `cost.total` 用于 CostGuard 续算) → 启动 `runAgent`
- 如果 `opts.message`,注入 `steeringQueue`(同 `steer` 接口语义)

**`src/guardrails/cost-guard.ts`**(扩展)
- 现有 `trackUsage()` 已有,加 `getLastInputTokens(): number | null` 读最新一次
- `resume` 时 `CostGuard` 实例化要从 session 落盘的 `cost.total` 续算,不能从 0 开始 — 否则 UI 看到的花费突然归零

**`src/server/runtime-supervisor.ts`**(删除)
- PM 拍板删除。Recovery 由 `sessionManager.resume()` 负责,不需要独立的 supervisor。
- 旧代码是 task-centric 命名,改造成 session-centric 等于重写,价值 < 删除。
- 同时清理 `src/server/` 里其它对 supervisor 的引用(`http-server.ts` 中可能有 `runtimeSupervisor` 字段,grep 后处理)

### 4.2 Compaction 接入

**`src/agent-runner.ts`**
- 把 `transformContext: makeTransformContext()` 改成 `makeTransformContext(guardrails)` — 让 transform 看得到 costGuard
- `transformContext`:**保留** LastN 兜底(压缩失败时的安全网),逻辑不变
- **新增** `config.prepareNextTurn = makePrepareNextTurn(guardrails)`,在 `runAgent` 入口注册
- `prepareNextTurn` 实现:每 turn 末读 `costGuard.getLastInputTokens()` → 超过 120K 阈值 → 调 `Pi.prepareCompaction(entries)` → 发 `COMPACTION` 事件 → 不阻塞 turn 继续

**`src/guardrails/compaction.ts`**(新文件)
- 薄包装 `Pi.prepareCompaction`,处理 `SessionEntry[]` ↔ `AgentMessage[]` 的转换(Pi 的输入是 entries,我们的是 messages)
- 失败兜底:压缩失败时打 `COMPACTION_FAILED` 事件,**不**让 LLM 看到损坏的 messages

**`src/guardrails/types.ts`**
- `GuardrailConfig` 加 `compaction?: { thresholdTokens: number }`(默认 120K)
- 未来可让用户在 Settings 调

**`src/core/persistence/schema.ts`**
- `PersistedEventType` 加 `COMPACTION`、`COMPACTION_FAILED`、`REPLAY_REPAIRED`

### 4.3 Resume UI

**`desktop/src/components/SessionView.tsx`**
- header 右侧加 "Resume" 按钮(条件渲染:`status === 'failed' || status === 'cancelled'`)
- 点击弹 `ResumeDialog`(复用 ApprovalDialog 风格):可选文本框,placeholder "Optional: e.g. also fix the failing tests"
- 提交调 `POST /sessions/:id/resume { message? }`,成功后切到 running 状态(由 SSE `session_started` 事件驱动)

**`desktop/src/lib/api.ts`**
- 加 `resumeSession(id, message?: string): Promise<void>`

**`desktop/src/lib/store.ts`**
- `Resume` 按钮的 disabled 态:`status` 不在白名单时禁用

### 4.4 HTTP 路由

**`src/server/http-server.ts`**
- `POST /sessions/:id/resume` body `{ message?: string }` → `sessionManager.resume(id, { message })`
- 错误码:
  - `404` = session 不存在
  - `409` = session 状态不允许 resume(`running` / `completed`)
  - `500` = replay 失败

### 4.5 门禁

- **单元** `src/core/persistence/replay.test.ts`:配对校验、缺尾丢弃、护栏事件忽略、顺序正确
- **单元** `src/guardrails/compaction.test.ts`:阈值边界、单测 mock `getLastInputTokens`
- **单元** `src/guardrails/cost-guard.test.ts`:`getLastInputTokens` 返回最新一次
- **冒烟** `src/cli/smoke-recovery.ts`:创建 session → abort → resume → 验证 messages 恢复 + cost 续算
- **冒烟** `src/cli/smoke-compaction.ts`:注入超长 turn → 断言 `COMPACTION` 事件发出 + messages 缩短
- **冒烟** `src/cli/smoke-resume-with-steering.ts`:创建 session → 失败 → resume 带 message → 验证 message 注入 steeringQueue
- **集成** `tests/integration/recovery.test.ts`:端到端 resume + compaction + 状态机正确切换

### 4.6 release-check.sh 更新

- 把 `smoke-recovery.ts` / `smoke-compaction.ts` / `smoke-resume-with-steering.ts` 加进冒烟序列
- 确认门禁无回归(Phase 1-4 冒烟仍全绿)

---

## 5. 工期估计

| 区块 | 代码量(含测试) | 节奏 |
|---|---|---|
| Recovery(replay + resume + CostGuard 续算 + 删 supervisor) | 500-700 行 | 1.5 天 |
| Compaction(prepareNextTurn + 转换层 + 兜底) | 250-400 行 | 0.5-1 天 |
| Resume UI + 路由 + dialog | 200-300 行 | 0.5 天 |
| 门禁(单测 + 冒烟 + 集成) | 含在上面 | 0.5 天 |
| **合计** | **950-1400 行** | **2.5-3.5 天** |

不含真机验收(PM 拿 API key 跑端到端)。

---

## 6. 风险与未决议题

- **Replay 一致性**:`event-log` 顺序由 FIFO 队列保证,但若历史上某条 message_end 之前已有 tool_use 没闭合,replay 时怎么处理?已定:**丢弃尾部 block,发 `REPLAY_REPAIRED` 事件**(`§4.1`)
- **压缩后 steer 行为**:`prepareNextTurn` 跑在 turn 边界,steering 消息正好在此刻到达,会被 LLM 当成新 turn 还是并入原 turn?需要跑 Pi 自己的 compaction test 套验证
- **Resume 后的 cost 累计**:已定:**`CostGuard` 从 session 落盘的 `cost.total` 续算**,不归零(`§4.1`)
- **空 messages 的 Session**:用户从未发过任何消息的 session 出现在列表里怎么处理?本次不处理(留 TODO)
- **压缩对 prompt cache 的影响**:PM 提醒:压缩会破坏 prompt cache,Claude Code 用 forked-agent cache sharing 缓解。Forge 本次**不**做 cache 优化,但**必须**发 `COMPACTION` 事件让 UI 显示 "压缩中" — 用户需要知道 LLM 行为可能变了
- **runtime-supervisor 删除的影响**:PM 拍板删除。需要 grep 全仓确认无其它引用(`http-server.ts` 可能存有 `runtimeSupervisor` 字段),无引用后删除整个文件

---

## 7. 决策记录

> PM 决策已敲定,本节记录最终选择与理由。

- [x] **D1**:Resume 语义 — **A(续上次跑)+ 可选 steering message**
- [x] **D2**:可 Resume 状态白名单 — **A(`failed` + `cancelled`)**
- [x] **D3**:压缩触发策略 — **A(按真实 token 数自动)+ 取最后一轮 `inputTokens` + 阈值默认 120K input tokens**

**额外决议**(PM 补充):
- [x] `replaySession` 只重建 messages,不重建 guardrail 状态(STUCK_WARNING / COST_UPDATE 等是审计用,不是状态重建用)
- [x] `CostGuard` 从 session 落盘的 `cost.total` 续算,resume 时不归零
- [x] 触发压缩后必须发 `COMPACTION` 事件,UI 显示 "压缩中"(LLM 行为可能变化,用户需要感知)
- [x] `src/server/runtime-supervisor.ts` 删除,Recovery 完全由 `sessionManager.resume()` 负责

**Anvil 反思**:初稿 D3 写"累计 usage.inputTokens"是错误的,被 PM 纠正。已在本节记录并改写。后续涉及 provider usage 的设计必须先想清楚"该读当前轮还是历史总和"。