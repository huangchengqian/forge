# Phase 5.1 Decision — EventBus 协议去留

> 决策归属：Anvil ↔ 产品经理
> 触发：Phase 5 收尾时，PM 提出"删掉 bus event 回调"以清理 Phase 2 遗留
> 当前状态：**已拍板** — Phase 5.1 修正版 C（appendEvent fan-out；统一 PersistedEventType；删 ForgeEvent）
> 写入时间：2026-09-09（拍板更新：2026-09-09）

---

## 1. 触发问题

Phase 2 留下的 `session-manager.ts:285` 是一段语义错位的 stub：

```typescript
onEvent: () => this.opts.bus.publish({
  type: "session_started",
  sessionId,
  goal: session.goal,
  at: Date.now(),
}),
```

它做了三件错事：

1. `onEvent` 在 `runAgent` 里的真实签名是 `(event: AgentEvent) => void`（见 `agent-runner.ts:51,90`），签名错位
2. 即便签名对，`session_started` 应当由 `manager.create()` 完成后触发，不该由 agent run 的第一次事件触发
3. 它无脑忽略 `event` 参数，每次 Pi 流过来事件都 publish 一个 `session_started` —— 实际只发一次，但语义全错

PM 提出"删掉 bus event 回调也去掉"，含义需要澄清。

---

## 2. 当前事实（Anvil 已验证）

### 2.1 双轨事件流已经设计分离

| 通道 | 类型 | 用途 | 延迟 |
|---|---|---|---|
| **events.jsonl** (`appendEvent`) | `PersistedEventType`（agent 流） | SSE 桌面流、recovery、audit | 250ms 轮询 |
| **EventBus** (`publish`) | `ForgeEvent`（控制面） | ApprovalDialog / StuckWarning / CostGauge 实时 UI 反馈 | in-process 同步 |

设计来源：`AGENTS.md §7`（事件规则）+ `events/event-types.ts:5-8` 注释明确说明双轨分离。
证据：`http-server.ts:29` 注释 `void bus.subscribe(() => {}); // keep the bus alive; SSE is log-tailed`

### 2.2 当前 EventBus 真实使用情况

```bash
$ grep -rn "bus\.publish" src/
src/server/session-manager.ts:285:onEvent: () => this.opts.bus.publish({  ← 唯一调用点（stub）
src/events/publisher.ts:6:  bus.publish(event);                            ← helper 实现
```

**结论**：9 个 ForgeEvent 类型中，**0 个有真实来源**（除 stub 那一行）。`events/publisher.ts` 的 `publish()` helper 也没人调用。

具体空缺：

| ForgeEvent 类型 | 预期来源 | 现状 |
|---|---|---|
| `session_started` | `manager.create()` 完成 | ❌ stub 错位 |
| `session_ended` | `manager.settle()` / catch | ❌ 0 调用 |
| `steering_queued` | `manager.steer()` | ❌ 0 调用（只 appendEvent） |
| `guard_blocked` | `before-tool-call.ts` | ❌ 0 调用 |
| `guard_approval_request` | `before-tool-call.ts` | ❌ 0 调用 |
| `verification_result` | `should-stop-after-turn.ts` | ❌ 0 调用 |
| `cost_update` | agent-runner 的 COST_UPDATE | ❌ 0 调用（只 appendEvent） |
| `stuck_warning` | `should-stop-after-turn.ts` | ❌ 0 调用 |
| `evaluation_completed` | `evaluation/deterministic-evaluator.ts` | ❌ 0 调用 |

### 2.3 为什么不能简单"全删"

- **AGENTS.md §9.2** 的 Guardrail ↔ UI 表格：
  - Guard ask → ApprovalDialog (real-time popup)
  - Cost budget → CostGauge (spent/budget)
  - Stuck detection → StuckWarning (pattern + suggestion)
  - Verification → VerificationPanel
  - 这些"实时弹窗"需要**亚秒级**反馈，250ms 文件轮询够用但**不理想**

- 删掉 EventBus 后这些 UI 钩子**没有协议可用**——要么改协议（重新设计事件类型），要么把它们绑死在文件轮询上（实时性砍到 250ms+）

---

## 3. 三个候选方案

### 方案 (A) — 全部删掉

**内容**：
- 删 `src/events/event-bus.ts` / `event-types.ts` / `publisher.ts` / `index.ts`
- 删 `src/server/session-manager.ts` 的 `bus: EventBus` 字段 + 所有 publish 调用
- 删 `src/server/http-server.ts:28-29` 的 `bus = new EventBus(); void bus.subscribe(...)`
- 改桌面端依赖文件轮询（已 OK），但**所有实时 UI 弹窗延迟 = 250ms**

**Anvil 反对理由**：
1. AGENTS.md §9.2 表格里"实时弹窗"用 SSE 文件轮询**违反设计意图**（虽然能跑）
2. 删协议后，将来想做 ApprovalDialog 实时反馈要重写协议类型
3. **回退路线，不是前进**。承认"0 调用" ≠ 承认"协议无用"
4. 改动面积大（5 个文件 + 桌面端契约）但没解决根本问题（UI 实时性）

**Anvil 是否会照做**：会，但**再次询问确认**——这是路线级决策。

### 方案 (B) — 删 stub，保留骨架

**内容**：
- `runAgent` 签名去掉 `onEvent?: (event: AgentEvent) => void`（不再需要）
- `session-manager.ts:285` 删掉错位的 `onEvent: () => bus.publish(...)`
- 改 `manager.create()` 在最后一行 `bus.publish({type:"session_started",...})`
- 改 `manager.settle()` / catch 路径 publish `session_ended`
- EventBus / ForgeEvent 类型**保留不动**
- **暂不**补全其余 7 个护栏 publish 点（留到 Phase 5.x）

**Anvil 立场**：**倾向**。理由：
- 最小改动修掉 Phase 2 真实瑕疵（语义错位）
- 保留骨架，未来补 7 个 publish 时不用重写协议
- 工作量 30 分钟

### 方案 (C) — 删 stub + 补全 8 个显式 publish

**内容**：
- (B) 全部内容 +
- `manager.steer()` 加 `bus.publish({type:"steering_queued"})`
- `before-tool-call.ts` 拒绝路径加 `bus.publish({type:"guard_blocked"})`
- `before-tool-call.ts` approval 路径加 `bus.publish({type:"guard_approval_request"})`
- `should-stop-after-turn.ts` verification 完成加 `bus.publish({type:"verification_result"})`
- `should-stop-after-turn.ts` stuck 触发加 `bus.publish({type:"stuck_warning"})`
- agent-runner.ts 的 COST_UPDATE 旁边加 `bus.publish({type:"cost_update"})`
- evaluation/evaluator.ts 完成加 `bus.publish({type:"evaluation_completed"})`
- HTTP 层 SSE 路由需要去重（日志 + bus 双重来源）—— 按 sessionId+seq 去重

**Anvil 立场**：**也倾向**，但要小心 SSE 去重。

**风险**：
- 桌面端 SSE 当前只读 events.jsonl，不读 bus。bus 来源的事件**不会**从 SSE 流出，除非改 SSE 路由
- HTTP `/sessions/:id/stream` 路由要合并两路：drainFile（现有）+ bus.subscribe（新）
- 已有 `seq` 机制（event-stream.ts:7-9），可按 seq 去重——但 JSONL 文件里没 seq，需要在 events.jsonl 写入时加 seq，或者 SSE 层独立编号

**工作量**：1.5-2 小时（含去重方案落地 + 冒烟）。

---

## 4. Anvil 反对删除的依据

1. **ForgeEvent 协议**对应 AGENTS.md §9.2 表格的**实时 UI 入口点契约**。删了之后，"ApprovalDialog 实时弹窗" 在路线图里不再有协议支撑。

2. **当前 0 调用 ≠ 协议无用**。空的是实现层（guardrails 没 publish），不是协议层（类型定义）。修实现层（方案 C）才对。

3. **删骨架恢复成本高**。一旦桌面端 SSE 单独走日志、bus 没了，未来要加实时反馈必须重新设计 ForgeEvent 类型 + 改 SSE 路由 + 改桌面端消费代码。这是一次 5+ 文件的协议变更，不是单点修复。

4. **不是路线分歧，是工程判断**。Anvil 作为首席开发者对"删还是修"做工程评估；但若 PM 决定删（方案 A），Anvil 会执行，并在 commit message 里记录 Anvil 立场让将来回看时知道这是路线决策不是技术判断。

---

## 5. 推荐顺序（历史快照 — 拍板前 Anvil 的推荐，已被 §6 取代）

**短期**（30 分钟）：方案 (B) — 修 Phase 2 真实瑕疵，骨架保留。

**中期**（2 小时）：方案 (C) — 补全 8 个显式 publish，让 ApprovalDialog / StuckWarning / CostGauge 的实时反馈有协议支撑。

**不在路线上**：方案 (A) — 除非 PM 明确说"实时 UI 不做了"。

---

## 6. PM 拍板 — Phase 5.1 修正版 C

2026-09-09 PM 拍板（高人力荐删 ForgeEvent，PM 采纳）。

**直接做修正版 C。不做 B，不做 A。**

1. `appendEvent` 成功后 fan-out 到 EventBus —— bus 是 event log 的扇出，不是独立路径
2. 统一类型系统为 PersistedEventType，删 ForgeEvent
3. 删 `onEvent` 回调（被 appendEvent 内部 fan-out 替代）
4. SSE 只读 event log（不变）
5. Desktop UI 只读 SSE（不消费 bus）

**不做 B**：B 修 stub 的代码会被 C 的 appendEvent fan-out 直接替掉。先做等于写一遍扔一遍。

**不做 Anvil 原始 C**：Anvil 原始 C 假设 SSE 要合并 log + bus 双重来源 —— 错误前提。SSE 永远只读 event log，bus 不流入 SSE；bus 是 appendEvent 的扇出，不是并行路径，不需要 seq 去重。**此点 Anvil 接受并收回。**

**类型统一的前提（PM）**：PersistedEventType 已覆盖全部事件类型（agent 事件 + 护栏事件都已写进 JSONL），ForgeEvent 当前 0 个真实消费者，迁移成本为零，不需要映射层。

---

## 6.1 Anvil 最终辩驳（记录在案，不阻止执行）

PM 已拍板，Anvil 按修正版 C 执行。以下辩驳**不是翻案**，是记录在案，供将来第一个 in-process 订阅者出现时回看。

Anvil 承认对的部分：appendEvent fan-out 解决"0 来源"是对的；删 `onEvent` stub 是对的；SSE/UI 只读 log 是对的；"SSE 合并双源 + seq 去重"是原始 C 的错误前提，已收回。

分歧收敛到**唯一一点：bus 的协议面是否保留"控制面 vs 数据面"区分**。

### 辩驳 1（事实）— "PersistedEventType 已覆盖全部事件类型"不成立

实测 `src/core/persistence/event-log.ts` 的 `PersistedEventType`：

| ForgeEvent 控制面类型 | PersistedEventType 里有没有 |
|---|---|
| `GUARD_BLOCKED` | ❌ 无 |
| `GUARD_APPROVAL_REQUEST` | ❌ 无 |
| `EVALUATION_COMPLETED` | ❌ 无 |

Phase 2/3 只设计了这三个的 bus 类型，**从未写进 JSONL**。因此"统一类型 = 0 成本迁移"不成立。真实执行成本是三步：**(a) 往 PersistedEventType 补 3 个类型（磁盘 schema 变更）→ (b) 补 3 个事件写入源 → (c) 删 ForgeEvent**。若只按"删类型"执行而漏掉 (a)(b)，这三个控制面事件在统一后永久丢失。

### 辩驳 2（架构）— 统一后 bus 协议面从"控制面 9 事件"膨胀为"全部 agent 流"

修正版 C 的 fan-out 若把全部 PersistedEvent 推到 bus，订阅者会收到 `MESSAGE_STARTED` / `TEXT_DELTA` / `TOOL_CALL` 等数据面洪泛。今天的 0 消费者让代价隐形；代价在第一个 in-process 订阅者（analytics / 跨 guardrail 通信 / watchdog）出现那天开始付：每个订阅者都要自写"哪些类型是我关心的"过滤，控制面边界散落各订阅者，**失去单一权威定义**。AGENTS.md §7 双轨设计（log = 全量事实源，bus = 控制面通知）就此消失，且无机制阻止数据面/控制面在 bus 上重新混淆。

### 辩驳 3（演进）— in-process 协议类型与磁盘格式耦合

`PersistedEventType` 是落盘格式，受 AGENTS.md §8.2 forward-only migration 约束。拿它当 in-process 通知协议类型 = 磁盘格式演进（加 migration）会连带污染进程内协议。两者的演进速度和兼容约束本应不同。

### 辩驳 4（替代成本）— 保留区分的增量成本接近零

若要消除的是"两套独立类型定义的维护成本"，替代做法是让控制面成为 `PersistedEventType` 的**类型级子集**（约 10 行：`type ControlEvent = Extract<...>` + fan-out 处过滤），与修正版 C 的其余部分 100% 兼容，只多保留一个薄类型层。

### Anvil 对"高人删"立场的承认

若高人建议删的论点是 YAGNI（0 消费者时任何为将来设计的抽象都是负债），此论点 Anvil 反驳不了——它与辩驳 2 是同一枚硬币的两面。Anvil 唯一的坚持：ForgeEvent 不是空想抽象，它是 AGENTS.md §9.2 UI 契约表的具体化，**有文档锚点**。删它 = 文档与代码必须同步改；文档需诚实标注"控制面通知协议已并入 PersistedEventType，控制面边界待第一个订阅者出现时重建"。

### 结论

执行：按修正版 C。净效果记录在案：

1. 丢失"控制面边界"的单一权威定义
2. 三个护栏类型（`GUARD_BLOCKED` / `GUARD_APPROVAL_REQUEST` / `EVALUATION_COMPLETED`）从"待实现"变成"必须先补进磁盘 schema"（执行前置，见辩驳 1）
3. bus 协议类型与磁盘格式耦合（forward-only migration 约束上浮到进程内协议）

若未来第一个 in-process 订阅者要求"只收控制面"，届时需重建过滤层，成本高于今天保留薄类型层。

---

## 7. 决策记录

> **PM 拍板**（2026-09-09）：修正版 C — `appendEvent` fan-out 到 EventBus；统一类型为 `PersistedEventType`；删 ForgeEvent；删 `onEvent` 回调；SSE 只读 log；Desktop UI 只读 SSE。参考高人力荐删 ForgeEvent。
>
> **Anvil 立场**：反对删 ForgeEvent 类型（辩驳见 §6.1，4 条理由），不阻止执行。原始 C 中"SSE 合并 log + bus 双源"的错误前提已收回。
>
> **执行前置（Anvil 提出，PM 未否决）**：先往 `PersistedEventType` 补 `GUARD_BLOCKED` / `GUARD_APPROVAL_REQUEST` / `EVALUATION_COMPLETED` 三类型 + 对应写入源，再删 ForgeEvent。否则三个控制面事件在统一后永久丢失。
>
> **状态**：决策已记录。代码执行待 PM"开干"。

