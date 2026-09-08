# Forge 架构演进指导

> 基于 Forge 现有代码 + OpenCC (Claude Code) / SWE-agent / OpenHands SDK 的架构分析。
> 目标：为 Forge 从"状态机驱动"到"LLM 驱动 + 确定性护栏"的架构演进提供方向指导。

---

## 1. 当前架构诊断

### 1.1 现状

Forge 当前的架构是：**状态机是大脑，LLM 是执行引擎。**

```
UNDERSTAND → PLAN → EXECUTE → OBSERVE → FIX → EVALUATE → COMPLETE
```

每个任务强制走完整生命周期。LLM 通过 `runtime.prompt()` 被调用，每次拿到一个 step 的 prompt，执行完返回 `TurnResult`，Forge 验证后决定下一步。

### 1.2 核心问题

**状态机不够聪明来指挥一个会写代码的 agent。**

状态机的"决策"全部是规则查表：
- `canTransition(from, to)` — 状态转移表
- `decideFix(step, observation, dir)` — 拼模板 prompt
- `checkFixBudget(count, policy)` — 比数字
- `computeReadySteps(plan, completedIds)` — 过滤

这些是**护栏，不是智能**。真正的工程智能——理解失败根因、适应任务复杂度、跨步骤推理——全部超出状态机的能力范围。

### 1.3 行业共识

| 项目 | 主循环 | 大脑 | 状态机？ |
|---|---|---|---|
| Forge | 状态机（7 状态） | 状态机 | ✅ 强制 |
| SWE-agent (SOTA) | `while not done` | LLM | ❌ |
| OpenHands SDK | `while not done` | LLM | ❌（GoalController 可选） |
| OpenCC (Claude Code) | `while not done` | LLM | ❌（PlanMode 是工具） |

四个项目里只有 Forge 用状态机当大脑。SWE-agent 正在主动简化到 100 行 Python（mini-swe-agent，65% SWE-bench）。

**行业共识是：LLM 驱动主循环 + 确定性护栏。**

---

## 2. 目标架构

### 2.1 核心原则

**LLM 是大脑，护栏是基础设施。**

```
LLM 驱动主循环（while not done）
  │
  ├── 上下文管理（压缩/裁剪/缓存）
  ├── 工具生态（文件/执行/搜索/MCP）
  ├── 记忆系统（语义检索）
  │
  └── 确定性护栏（不是大脑，是安全网）
      ├── 完成验证（不信任"模型说做完了"）
      ├── 成本预算（防止无限重试）
      ├── 卡住检测（重复模式识别）
      ├── 错误恢复（格式错误重问）
      ├── 权限/安全（能力策略 + undo journal）
      ├── 审计日志（结构化事件流）
      └── 崩溃恢复（event log + journal）
```

### 2.2 与现状的关系

| 当前组件 | 目标角色 | 处置 |
|---|---|---|
| 状态机（engine.ts） | 不再是主循环 | 降级为护栏（见 §3） |
| `runtime.prompt()` 阻塞调用 | LLM 驱动的流式循环 | 重写主循环（见 §4） |
| Pi runtime | 从"agent runtime"降级为"模型适配器" | 边界下移（见 §5） |
| AgentRuntime 接口 | 保留分层，但接口变丰富 | 接口扩展（见 §5） |
| validate.ts（7 种验证器） | 完成验证护栏 | **保留** |
| guard/policy.ts（能力策略） | 权限护栏 | **保留** |
| guard/journal.ts（undo journal） | undo 护栏 | **保留** |
| event-log.ts（FIFO event log） | 审计 + 恢复护栏 | **保留** |
| task-store.ts + schema.ts | 持久化 + 迁移 | **保留** |
| recovery-service.ts | 崩溃恢复护栏 | **保留** |
| llm-planner.ts | LLM 自己规划，不再需要外部 planner | **移除** |
| scheduler.ts（DAG 调度器） | 死代码 | **删除** |
| retry-policy.ts | 成本护栏 | **保留，重构为护栏** |
| fix-decision.ts | LLM 自己看结果修，不需要外部 FIX 状态 | **移除**（卡死守卫逻辑保留为护栏） |
| evaluator.ts | 完成验证护栏 | **保留** |
| skills/registry.ts | LLM 自己选择工具 | **移除** |
| intent-router.ts | 简化为 prompt 分类 | **保留，简化** |

### 2.3 架构分层（不变）

分层原则不变——Forge 和 Pi 之间保持清晰边界：

```
Forge（agent 系统：LLM 循环 + 工具 + 护栏）
    ↓ AgentRuntime 接口（扩展，不再是黑箱）
Pi（模型适配器：LLM 通信 + 基础 agent 能力）
    ↓ HTTP API
Model Provider（GLM / DeepSeek / Qwen / ...）
```

**Pi 仍然是独立内核。** 变化的是边界位置——从"agent runtime 层"下移到"模型 API 层"。Forge 自己拥有 agent loop、工具、上下文管理、护栏。Pi 只负责跟 LLM 通信。

---

## 3. 状态机降级方案

### 3.1 从强制流程到可选模式

当前状态机是强制的——每个任务必须走 UNDERSTAND → PLAN → EXECUTE → OBSERVE → FIX → EVALUATE → COMPLETE。

目标：LLM 主循环里，这些变成**可选的、按需调用的能力**：

```
while not done:
    response = llm.query(context)
    if response.is_plan_request:
        enter_plan_mode()        # 对应 UNDERSTAND + PLAN
    elif response.is_verify_request:
        run_verification()       # 对应 OBSERVE
    elif response.is_done:
        if verify_completion():  # 对应 EVALUATE
            done = true
        else:
            tell_llm_to_continue()
    execute_tool_calls(response)  # 对应 EXECUTE
```

### 3.2 保留什么

| 状态机能力 | 保留形式 | 理由 |
|---|---|---|
| `validate()` | 完成验证护栏 | 不信任"模型说做完了" |
| `checkFixBudget()` | 成本预算护栏 | 防止无限重试 |
| `failureSignature()` | 卡住检测护栏 | 识别重复失败模式 |
| `appendEvent()` | 审计日志 | 结构化事件流 |
| `TaskRecoveryService` | 崩溃恢复 | event log + journal 回放 |
| `DeterministicEvaluator` | 完成评估 | 最后的确定性打分 |

### 3.3 移除什么

| 状态机能力 | 理由 |
|---|---|
| `UNDERSTAND` 状态 | LLM 自己读代码、理解需求 |
| `PLAN` 状态 | LLM 自己规划（或按需进入 plan mode） |
| `EXECUTE` 状态 | 就是主循环里执行 tool call |
| `OBSERVE` 状态 | LLM 自己看 tool result |
| `FIX` 状态 | LLM 自己看到失败就修 |
| `EVALUATE` 状态 | 变成完成验证护栏 |
| `canTransition()` 转移表 | 不再需要状态转移 |
| `LlmPlanner` | LLM 自己出 plan |
| `decideFix()` | LLM 自己决定怎么修 |

---

## 4. 主循环重写方案

### 4.1 当前主循环（状态机）

```typescript
// engine.ts — 状态机主循环
while (!isTerminal(task.state) && Date.now() < deadline) {
    switch (task.state) {
        case "UNDERSTAND": ... planner.createPlan() ...
        case "PLAN": ... transition("EXECUTE") ...
        case "EXECUTE": ... scheduler.select() → runStepBatch() ...
        case "OBSERVE": ... validate() → allPassed? ...
        case "FIX": ... decideFix() → runtime.prompt() ...
        case "EVALUATE": ... evaluator.evaluate() ...
    }
}
```

### 4.2 目标主循环（LLM 驱动）

```typescript
// 新的 agent loop — LLM 驱动，护栏兜底
async function runAgentLoop(handle: AgentHandle): Promise<TaskSession> {
    const { runtime, session, bus } = handle;
    const guardrails = handle.guardrails;  // 成本/卡住/验证/恢复
    let task = handle.task;

    while (!guardrails.isDone() && !guardrails.isBudgetExhausted()) {
        // 1. 构建上下文（system prompt + history + tools）
        const context = buildContext(task, session);

        // 2. 调 LLM（流式，不是阻塞）
        const response = await runtime.query(session, context, {
            onDelta: (delta) => streamToEventLog(task.id, delta),
            onToolCall: (call) => guardrails.checkPermission(call),
        });

        // 3. 执行 tool calls
        for (const call of response.toolCalls) {
            const result = await executeTool(call);
            appendToHistory(task, call, result);
            guardrails.checkStuck(task);  // 卡住检测
            guardrails.checkBudget(task);  // 成本检查
        }

        // 4. 完成判断
        if (response.done) {
            const verified = await guardrails.verifyCompletion(task);
            if (verified.passed) {
                task = await completeTask(task, bus);
            } else {
                // 告诉 LLM 验证没过，继续
                appendToHistory(task, "verification_failed", verified.reason);
            }
        }
    }

    return task;
}
```

### 4.3 关键变化

| 现在 | 目标 |
|---|---|
| `runtime.prompt()` 阻塞调用 | `runtime.query()` 流式调用 + 事件回调 |
| orchestrator 不看执行过程 | `onToolCall` / `onDelta` 实时消费 |
| PLAN → EXECUTE → OBSERVE 分离 | 一个循环里完成：query → execute → observe → continue |
| FIX 状态：拼模板 prompt 重试 | LLM 自己看到 tool result 就知道该不该修 |
| 每个 step 有 `successCriteria` | 完成时跑验证护栏（可选配置 criteria） |

---

## 5. Pi 角色与接口变化

### 5.1 Pi 的角色变化

| | 现在 | 目标 |
|---|---|---|
| Pi 拥有 | agent loop、工具、上下文管理、压缩 | LLM 通信、基础工具调用 |
| Forge 拥有 | 状态机、验证、记忆、恢复 | agent loop、工具、上下文、记忆、护栏 |
| 边界位置 | AgentRuntime（prompt + abort） | ModelAdapter（query + stream + tools） |

### 5.2 接口变化

**现在的 AgentRuntime（黑箱）：**

```typescript
interface AgentRuntime {
    createSession(opts): Promise<RuntimeSession>;
    prompt(session, message, opts?): Promise<TurnResult>;  // 阻塞
    abort(session): Promise<void>;
    destroy(session): Promise<void>;
}
```

**目标的 ModelAdapter（透明）：**

```typescript
interface ModelAdapter {
    createSession(opts): Promise<Session>;

    // 流式查询：yield 事件，不是阻塞返回
    query(session, context: QueryContext, opts?: QueryOptions): AsyncGenerator<AgentEvent>;

    // 中途干预
    steer(session, message: string): Promise<void>;
    abort(session): Promise<void>;
    destroy(session): Promise<void>;
}

type AgentEvent =
    | { type: "text_delta"; text: string }
    | { type: "tool_call"; tool: string; input: unknown }
    | { type: "tool_result"; output: string; error?: string }
    | { type: "thinking"; content: string }
    | { type: "message_end"; text: string }
    | { type: "done" };
```

### 5.3 分层不变

**Pi 仍然是独立内核。** Forge 通过接口依赖 Pi，不直接 import Pi 实现。变化的是：
- 接口名字从 `AgentRuntime` 改为 `ModelAdapter`（语义更准确）
- 接口从阻塞 `prompt()` 变为流式 `query()` AsyncGenerator
- Pi 不再拥有 agent loop——它只负责 LLM 通信和基础工具

---

## 6. 工具体系

### 6.1 当前问题

Forge 没有自己的工具——所有工具调用委托给 Pi 的 `prompt()`。Forge 不知道 Pi 有什么工具、agent 调了什么工具、工具结果是什么。

### 6.2 目标

Forge 拥有自己的工具体系。LLM 主循环里，tool calls 是一等公民：

```typescript
// 工具定义
interface Tool {
    name: string;
    description: string;
    inputSchema: JSONSchema;
    execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// 内置工具
const BUILTIN_TOOLS: Tool[] = [
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    bashTool,        // 受 guard 策略约束
    grepTool,
    globTool,
    // ... 按需扩展
];
```

### 6.3 工具执行流程

```
LLM 输出 tool_call
    ↓
Guard 检查权限（classifyCapabilities + evaluateToolCall）
    ↓ allow
Journal 备份文件（如果是 write/edit）
    ↓
执行工具
    ↓
Tool result → 加入 history
    ↓
卡住检测（重复的 tool_call + 相同 result）
```

Guard 和 journal 直接复用现有代码。

---

## 7. 上下文管理

### 7.1 当前问题

Forge 没有上下文管理——`buildStepPrompt` 每次构造一个新 prompt，没有对话历史，没有压缩，没有 token 估算。10 分钟 deadline 是唯一的上下文限制。

### 7.2 目标

参考 OpenCC 的 11 种压缩策略，分阶段实现：

**第一阶段（最小可用）：**
- 对话历史管理（messages 数组，不是每步新 prompt）
- 简单 token 估算（按字符数近似）
- 接近窗口时自动截断旧消息（LastN 策略）

**第二阶段：**
- prompt cache（缓存 system prompt + 历史 prefix）
- 微压缩（裁剪单条过长的 observation）

**第三阶段：**
- 自动压缩（接近窗口时 LLM 生成摘要替代旧历史）
- 多策略压缩（参考 OpenCC 的 autoCompact / microCompact / reactiveCompact）

### 7.3 上下文构建

```typescript
function buildContext(task: TaskSession, session: Session): QueryContext {
    return {
        systemPrompt: buildSystemPrompt(task),  // 角色 + 工具描述 + guard 规则
        messages: session.history,              // 完整对话历史
        tools: session.tools,                   // 可用工具
        workingDirectory: task.workspacePath,
    };
}
```

---

## 8. 记忆系统

### 8.1 当前问题

- 纯词袋匹配（`[^a-z0-9]+` 分割），CJK 完全失效
- 只在 plan 前检索一次，执行中不召回
- 提取规则简单（COMPLETE → PROJECT_FACT，FAILED → FAILURE_PATTERN）

### 8.2 目标

参考 OpenHands 的 `findRelevantMemories`——用 LLM 做语义检索：

```
记忆文件（.md 带 frontmatter）
    ↓
扫描 frontmatter（description + type）
    ↓
LLM 做相关性选择（"这 5 个记忆里哪些对当前查询有用？"）
    ↓
注入到 context
```

**不需要 embedding**——用 LLM side query 做相关性选择就够了（OpenHands 就这么做的，用 Sonnet 选记忆）。

### 8.3 记忆格式

从单一 JSON 文件改为文件目录：

```
~/.forge/memory/
    MEMORY.md              # 索引
    project-patterns.md    # 项目模式
    failure-log.md         # 失败记录
    solutions.md           # 解决方案
    ...
```

每个文件带 frontmatter：
```markdown
---
description: 使用 repository pattern 的项目架构
type: PROJECT_FACT
keywords: [repository, pattern, architecture]
---
内容...
```

---

## 9. 卡住检测

### 9.1 当前状态

Forge 有一个简单的卡住检测：连续两次 POST-FIX 观察失败签名相同就停。

### 9.2 目标

参考 OpenHands 的 StuckDetector，扩展为 4 种模式：

| 模式 | 描述 | 阈值 |
|---|---|---|
| action_observation_loop | 重复相同的 action-observation 对 | 4 次 |
| action_error_loop | 重复相同的 action-error 对 | 4 次 |
| monologue | agent 连续自说自话无工具调用 | 4 次 |
| alternating_pattern | 在两个 action 之间反复横跳 | 6 次 |

```typescript
class StuckDetector {
    check(events: AgentEvent[]): StuckResult {
        // 1. 检查重复的 action-observation 对
        // 2. 检查重复的 action-error 对
        // 3. 检查无工具调用的连续消息
        // 4. 检查交替模式
    }
}
```

---

## 10. 完成验证

### 10.1 核心原则不变

**完成不信任"模型说做完了"。** 这是 Forge 最重要的设计决策，必须保留。

### 10.2 从强制 criteria 到可配置门槛

当前：每个 step 有 `successCriteria`，必须在 OBSERVE 状态通过。

目标：完成时按**信任级别**验证：

```typescript
type TrustLevel = "low" | "medium" | "high";

interface CompletionConfig {
    trustLevel: TrustLevel;
    criteria?: SuccessCriterion[];  // 高信任时必须配置
}

async function verifyCompletion(task: TaskSession, config: CompletionConfig): Promise<VerifyResult> {
    switch (config.trustLevel) {
        case "low":
            return { passed: true };  // 模型说做完就做完
        case "medium":
            // 跑基础检查（build pass / test pass）
            return await runBasicChecks(task);
        case "high":
            // 跑所有 criteria + evaluator
            return await runFullVerification(task, config.criteria);
    }
}
```

---

## 11. 演进路线

### 阶段 1：睁开眼（最小改动，最大收益）

**目标：让 orchestrator 消费 Pi 的事件流。**

- [ ] `AgentRuntime.prompt()` 增加事件回调（不改接口，加 `onEvent` option）
- [ ] orchestrator 在 EXECUTE 期间消费事件，做实时决策：
  - agent 写 workspace 外的文件 → abort
  - 长时间无事件 → 超时
  - 重复的 tool_call + 相同 result → 卡住检测
- [ ] 保留状态机，但在 EXECUTE 里实时干预

**不推翻任何东西。只是让 orchestrator 从闭眼变睁眼。**

### 阶段 2：工具体系

**目标：Forge 拥有自己的工具。**

- [ ] 定义 `Tool` 接口
- [ ] 实现 5 个基础工具：file_read, file_write, file_edit, bash, grep
- [ ] Guard 接入工具执行（复用 policy.ts + journal.ts）
- [ ] 工具结果进入 history

### 阶段 3：LLM 驱动主循环

**目标：用 LLM 主循环替换状态机。**

- [ ] 实现 `runAgentLoop`（while not done 循环）
- [ ] LLM 自己规划、执行、观察、修复
- [ ] 状态机降级为护栏（完成验证 + 成本预算 + 卡住检测）
- [ ] 验证器、guard、journal、event log、recovery 全部保留

### 阶段 4：上下文管理

**目标：支持长对话。**

- [ ] 对话历史管理（messages 数组）
- [ ] token 估算
- [ ] 接近窗口时自动截断
- [ ] prompt cache

### 阶段 5：记忆系统

**目标：语义记忆检索。**

- [ ] 记忆格式改为文件目录 + frontmatter
- [ ] LLM 做相关性选择
- [ ] 每轮 prefetch + 注入

### 阶段 6：Pi 角色调整

**目标：Pi 降级为模型适配器。**

- [ ] AgentRuntime → ModelAdapter
- [ ] 接口从 `prompt()` 改为 `query()` AsyncGenerator
- [ ] Pi 只负责 LLM 通信，不再拥有 agent loop

---

## 12. 保留清单

以下代码**不需要重写**，直接在新的 LLM 驱动循环里复用：

| 文件 | 作用 | 复用方式 |
|---|---|---|
| `verification/validate.ts` | 7 种确定性验证器 | 完成验证护栏 |
| `verification/command-policy.ts` | 命令白名单 + workspace 限制 | bash 工具的权限检查 |
| `guard/policy.ts` | 能力策略 + 规则评估 | 工具执行前的权限检查 |
| `guard/journal.ts` | undo journal（文件备份） | write/edit 工具执行前备份 |
| `guard/extension.ts` | Pi 扩展入口 | 保留直到 Pi 角色变化 |
| `core/persistence/event-log.ts` | FIFO event log | 审计日志 + SSE 流 |
| `core/persistence/task-store.ts` | 任务持久化 | 保留 |
| `core/persistence/schema.ts` | schema 迁移 | 保留（可能加 v4 迁移） |
| `recovery/recovery-service.ts` | 崩溃恢复 | 保留 |
| `evaluation/deterministic-evaluator.ts` | 完成评估 | 保留为完成验证护栏 |
| `server/undo.ts` | diff + undo | 保留 |
| `server/approval-hub.ts` | 审批中继 | 保留 |
| `server/runtime-supervisor.ts` | 崩溃监控 | 保留 |
| `events/event-bus.ts` | 事件总线 | 保留 |

---

## 13. 不要做的事

1. **不要一步到位。** 阶段 1（睁开眼）就能显著提升任务成功率。每个阶段独立可交付。

2. **不要删护栏。** 验证器、guard、journal、event log、recovery 是 Forge 真正比纯 LLM 循环强的地方。它们是 LLM 驱动循环的安全网。

3. **不要放弃分层。** Pi 作为独立内核的价值是架构卫生。边界位置会变（从 runtime 层下移到 model API 层），但分层本身不变。

4. **不要追求 OpenCC 的规模。** 522 个文件不是目标。SWE-agent 用 1294 行达到 SOTA，mini-swe-agent 用 100 行达到 65%。先做对，再做全。

5. **不要在状态机和 LLM 循环之间搞混合模式。** 选定 LLM 驱动主循环后，状态机干净降级为护栏，不要两者并存当主循环。

---

## 14. 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-09-08 | 状态机不是正确的大脑抽象 | 分析了 Forge + SWE-agent + OpenHands + OpenCC，3/4 用 LLM 当大脑，SWE-agent 主动简化 |
| 2026-09-08 | LLM 驱动主循环 + 确定性护栏是目标架构 | 行业共识 + SWE-agent mini-swe-agent 信号 |
| 2026-09-08 | Pi 保持独立内核，边界下移到 model API | 架构卫生 + 减少工作量 |
| 2026-09-08 | 验证/guard/journal/event log/recovery 全部保留 | 这些是 Forge 的真正价值 |
| 2026-09-08 | 分阶段演进，先睁眼再换脑 | 风险控制 + 每阶段独立可交付 |
