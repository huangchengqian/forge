# Phase 5 — Recovery + Compaction + Steering

> 状态: **范围已定,决策待拍**。本文件记录 Phase 5 边界、当前代码现状、以及动工前需要 PM 拍板的设计决策。

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

---

### 决策 D3:压缩触发策略

**问题**:什么时候触发 `prepareNextTurn`?

| 选项 | 触发条件 | 数据来源 |
|---|---|---|
| **A. 按真实 token 数自动**(推荐) | 累计 usage.inputTokens 超过阈值(默认 100K) | 复用 `CostGuard.trackUsage` 已落盘的 usage |
| B. 按 turn 数 | assistant turn > N 触发 | 简单但粗 — 不区分长 turn / 短 turn |
| C. 手动 | Settings 给用户开关 | 用户控制感强但暴露了不该暴露的旋钮 |

**推荐 A 的理由**:
- `costGuard` 已经在 `message_end` 收集 usage(见 `agent-runner.ts:87-97`),数据是权威的(provider 报的实际值,不是字符估算)
- 不需要新依赖
- 阈值可以放 ForgeConfig,未来给高级用户调

**待 PM 确认**:
- 阈值默认多少?(我建议 100K input tokens,匹配主流模型 context window 的 60-80%)
- 是否需要硬上限?超过某个值强制截断而不是只压缩(防止 OOM / 极端长 turn)

---

## 4. 决策敲定后的实现计划

> 此节是 D1/D2/D3 全部敲定后才走的实施路线,先不展开。

**预计工序**:

1. **Recovery 核心**(`src/server/session-manager.ts` + `src/core/persistence/`)
   - `replaySession(id)`: 从 event-log 重放 message_start / message_end 配对,组装 `AgentMessage[]`
   - `sessionManager.resume(id)`: 校验 status 在白名单 → 调 `runAgent({ session, messages: replayed })`
   - 删除或重写 `runtime-supervisor.ts`(本次顺手清掉旧 task-* 残留)

2. **Compaction 接入**(`src/agent-runner.ts` + `src/guardrails/`)
   - 把 `transform-context.ts` 的 LastN 兜底保留(作为压缩失败时的安全网)
   - `prepareNextTurn` 钩子:每 turn 末检查累计 inputTokens → 触发 `Pi.prepareCompaction`
   - 发 `COMPACTION` 事件,SessionView 显示 "Compacting history…"

3. **Resume UI**(`desktop/src/components/SessionView.tsx`)
   - SessionView header 加 "Resume" 按钮(条件渲染:status in 白名单)
   - 调 `POST /sessions/:id/resume`,成功后切到 running 状态

4. **HTTP 路由**(`src/server/http-server.ts`)
   - `POST /sessions/:id/resume` → `sessionManager.resume()`
   - 401/403/409 错误码(409 = session 仍在 running,不能 resume)

5. **门禁**
   - 单元:`replaySession.test.ts`(配对校验、缺尾丢弃、顺序正确)
   - 单元:`compaction-trigger.test.ts`(阈值边界、单测 mock usage)
   - 冒烟:`smoke-recovery.ts`(创建→abort→resume→续跑)
   - 冒烟:`smoke-compaction.ts`(注入超长 turn→断言 COMPACTION 事件发出)
   - 集成:`tests/integration/recovery.test.ts`(端到端)

---

## 5. 工期估计

| 区块 | 代码量(含测试) | 节奏 |
|---|---|---|
| Recovery | 400-600 行 | 1 天 |
| Compaction | 200-400 行 | 0.5-1 天 |
| Resume UI + 路由 | 150-250 行 | 0.5 天 |
| 门禁(单测 + 冒烟 + 集成) | 含在上面 | 0.5 天 |
| **合计** | **800-1250 行** | **2-3 天** |

不含真机验收(PM 拿 API key 跑端到端)。

---

## 6. 风险与未决议题

- **Replay 一致性**:`event-log` 顺序由 FIFO 队列保证,但若历史上某条 message_end 之前已有 tool_use 没闭合,replay 时怎么处理?需要给 `replaySession` 加自检并把脏数据降级(丢弃尾部 block,标注 `REPLAY_REPAIRED` 事件)
- **压缩后 steer 行为**:`prepareNextTurn` 跑在 turn 边界,steering 消息正好在此刻到达,会被 LLM 当成新 turn 还是并入原 turn?需要跑 Pi 自己的 compaction test 套验证
- **Resume 后的 cost 累计**:CostGuard 是 per-session 实例化的,resume 时需要从落盘 cost 续算而不是从 0 开始(否则 UI 看到的花费突然归零)
- **空 messages 的 Session**:用户从未发过任何消息的 session 出现在列表里怎么处理?本次不处理(留 TODO)

---

## 7. 决策记录

> 决策敲定后,把 PM 的回答填到这里。

- [ ] **D1**:Resume 语义 — 选项 ___
- [ ] **D2**:可 Resume 状态白名单 — 选项 ___
- [ ] **D3**:压缩触发策略 — 选项 ___(阈值默认 ___)