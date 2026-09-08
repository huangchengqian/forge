# Forge Next 架构设计文档

> 基于 Forge 现有代码 + Pi (earendil-works/pi, ~90K 行 MIT agent runtime) + OpenCC/SWE-agent/OpenHands 架构分析。

---

## 1. 项目定位

**一个 LLM 驱动的桌面端工程化 agent，用确定性护栏保证完成可信。**

- LLM 是大脑：自己规划、执行、观察、修复、决定完成
- 护栏是安全网：不信任"模型说做完了"，防卡死、防烧钱、防越权
- Pi 是 agent 引擎：提供 90K 行成熟的 LLM 通信 + agent loop + 工具 + 压缩
- Forge Next 的增量价值：在 Pi 之上加工程护栏层

---

## 2. 架构总览

```
Desktop (Tauri + React)
    │  HTTP + SSE
Forge Next Server (Node sidecar)
    │
    ├── AgentRunner（薄入口，调 Pi 的 agentLoop）
    │       │
    │       ├── Pi AgentLoopConfig hooks ← 护栏注入点
    │       │   ├── beforeToolCall   → Guard 权限检查 + Journal 备份
    │       │   ├── afterToolCall    → 卡住检测
    │       │   ├── shouldStopAfterTurn → 成本预算 + 完成验证
    │       │   ├── transformContext → 上下文管理（token 估算 + 截断）
    │       │   ├── prepareNextTurn  → 压缩（Pi 已有，可选增强）
    │       │   └── getSteeringMessages → 中途干预
    │       │
    │       └── Pi 内置能力（直接复用）
    │           ├── agent loop（LLM 驱动主循环）
    │           ├── 工具（read/write/edit/bash/grep/find/ls）
    │           ├── 上下文压缩（branch-summarization）
    │           └── 多 provider（OpenAI/Anthropic/Google/...）
    │
    └── 护栏基础设施
        ├── Guard（capability policy + undo journal）
        ├── 确定性验证（file_exists / command_exit_zero / test_pass / ...）
        ├── 卡住检测（重复模式识别）
        ├── 成本预算（token/费用追踪 + 熔断）
        ├── 事件日志（FIFO append + SSE 流 + 审计）
        └── 崩溃恢复（event log 回放 + journal 恢复）
```

---

## 3. 核心设计决策

### 3.1 LLM 是大脑，不是子程序

**决策：** 删除 Forge 的状态机（UNDERSTAND → PLAN → EXECUTE → OBSERVE → FIX → EVALUATE → COMPLETE）。Pi 的 `agentLoop` 就是主循环。LLM 自己规划、执行、观察、修复。

**理由：** SWE-agent / OpenHands / OpenCC 三个项目全部用 LLM 驱动主循环。SWE-agent 用 1724 行达到 SOTA，mini-swe-agent 100 行 65%。状态机不够聪明来指挥写代码的 agent——它的"决策"全是规则查表，不是真正的工程智能。

### 3.2 Pi in-process，不再 subprocess RPC

**决策：** 直接 `import { agentLoop } from '@earendil-works/pi-agent-core'`，不再 spawn Pi 子进程。

**理由：**
- 删掉 `runtime/pi/` 整个目录（pi-adapter 252 行 + rpc-client 257 行 + pi-process 76 行 + pi-paths 14 行）
- 不再有"两个 loop"问题——只有一个 loop（Pi 的 agentLoop），护栏通过 hooks 注入
- Pi 的事件直接在进程内消费，不需要 NDJSON 序列化 + stdin/stdout 管道

### 3.3 护栏通过 AgentLoopConfig hooks 注入

**决策：** Forge 的护栏代码适配成 Pi 的 `AgentLoopConfig` 回调，不写独立的 orchestrator。

Pi 已有的 hooks（`packages/agent/src/types.ts`）：

| Hook | 签名 | Forge 护栏接入 |
|---|---|---|
| `beforeToolCall` | `(ctx, signal) => Promise<BeforeToolCallResult>` | Guard 权限检查 + Journal 备份 |
| `afterToolCall` | `(ctx, signal) => Promise<AfterToolCallResult>` | 卡住检测（检查重复模式） |
| `shouldStopAfterTurn` | `(ctx) => boolean` | 成本预算 + 完成验证 |
| `transformContext` | `(messages, signal) => Promise<AgentMessage[]>` | Token 估算 + 截断 |
| `prepareNextTurn` | `(ctx) => AgentLoopTurnUpdate` | 压缩触发（Pi 已有压缩，可选增强） |
| `getSteeringMessages` | `() => Promise<AgentMessage[]>` | 中途干预（用户 steer / 护栏 steer） |
| `convertToLlm` | `(messages) => Message[]` | 消息格式转换（标准） |
| `getFollowUpMessages` | `() => Promise<AgentMessage[]>` | 队列后续消息 |

**这是最关键的架构决策——它消除了"两个 loop"问题。** 护栏不是外层循环，是 Pi loop 内部的回调。

### 3.4 完成验证作为 shouldStopAfterTurn 的 hook

**决策：** 不信任"模型说做完了"。当 LLM 停止调用工具时，`shouldStopAfterTurn` 检查是否满足完成条件。

```typescript
shouldStopAfterTurn: (ctx) => {
    // 1. 成本预算检查
    if (costGuard.isExhausted()) return true;

    // 2. 卡住检测
    if (stuckDetector.isStuck(ctx)) return true;

    // 3. 完成验证（可选，按信任级别）
    //    低信任：模型停就停
    //    中信任：跑 build/test
    //    高信任：跑所有 criteria + evaluator
    if (completionConfig.criteria) {
        const result = await validate(completionConfig.criteria, workspace);
        if (!result.allPassed) {
            // 验证没过 → 告诉 LLM 继续修
            injectSteering(`验证未通过: ${result.reason}。请继续修复。`);
            return false;  // 不停，继续
        }
    }
    return true;  // 停
}
```

---

## 4. 从 Forge 保留的代码

以下代码**直接复用**，不修改或仅改 import：

| 文件 | 行数 | 作用 | 在新架构中的角色 |
|---|---|---|---|
| `verification/validate.ts` | 235 | 7 种确定性验证器 | `shouldStopAfterTurn` 里调用 |
| `verification/command-policy.ts` | 95 | 命令白名单 + workspace 限制 | `beforeToolCall` 里检查 bash 工具 |
| `guard/policy.ts` | 273 | 8 类能力策略 + 规则评估 | `beforeToolCall` 里权限检查 |
| `guard/journal.ts` | 119 | undo journal（文件备份） | `beforeToolCall` 里备份 |
| `core/persistence/event-log.ts` | 90 | FIFO event log + CJK 修复 | 事件流消费（独立于 hooks） |
| `core/persistence/schema.ts` | 76 | schema 迁移（v0→v3） | 持久化基础设施 |
| `recovery/recovery-service.ts` | 71 | 崩溃检测 + 恢复计划 | 基于 event log 的恢复 |
| `evaluation/deterministic-evaluator.ts` | 137 | 完成后打分 | `shouldStopAfterTurn` 里调用 |
| `server/undo.ts` | 119 | diff + undo | HTTP API |
| `server/approval-hub.ts` | 53 | 审批中继 | HTTP API |
| `server/runtime-supervisor.ts` | 31 | 崩溃监控 | 基础设施 |
| `events/event-bus.ts` | 22 | 事件总线 | SSE 推送 |

**保留约 1230 行。**

---

## 5. 从 Forge 删除的代码

| 文件 | 行数 | 删除理由 |
|---|---|---|
| `orchestrator/engine.ts` | 709 | 状态机主循环——被 Pi agentLoop 替代 |
| `core/state/task-state.ts` | 38 | 状态转移表——不再需要 |
| `orchestrator/llm-planner.ts` | ~280 | 外部 planner——LLM 自己规划 |
| `orchestrator/planner.ts` | 35 | Planner 接口 |
| `orchestrator/scheduler.ts` | 60 | 死代码 |
| `orchestrator/fix-decision.ts` | 85 | FIX 状态逻辑——LLM 自己看结果修 |
| `orchestrator/instruction.ts` | 33 | step prompt 构造——不再有 step |
| `orchestrator/plan-ops.ts` | 50 | plan 操作——不再有 Plan |
| `orchestrator/runner.ts` | 79 | step 批量执行——不再有 step |
| `orchestrator/retry-policy.ts` | 32 | 重试策略——被 cost guard 替代 |
| `skills/` | ~200 | skill 系统——LLM 自己选工具 |
| `server/intent-router.ts` | ~350 | 意图路由——状态机的产物 |
| `runtime/pi/` | 599 | RPC 适配层——in-process import 替代 |
| `runtime/interface.ts` | 82 | AgentRuntime 接口——用 Pi 的类型 |
| `runtime/fake-runtime.ts` | 101 | FakeRuntime——用 Pi 的测试设施 |
| `core/types/plan.ts` | 10 | Plan 类型——不再有 Plan |
| `core/types/step.ts` | 27 | PlanStep/Observation——不再有 step |
| `core/persistence/task-store.ts` | 52 | task-store——适配新数据模型 |
| `server/task-manager.ts` | 981 | task-manager——重写为 conversation-centric |
| `server/http-server.ts` | 622 | HTTP API——重写为 conversation-centric |

**删除约 4400 行。**

---

## 6. 新增代码

### 6.1 AgentRunner（入口，~200 行）

```typescript
// src/agent-runner.ts
import { agentLoop } from '@earendil-works/pi-agent-core';
import type { AgentLoopConfig, AgentContext, AgentMessage } from '@earendil-works/pi-agent-core';

export async function runAgent(opts: {
    workspace: string;
    model: Model<any>;
    systemPrompt: string;
    tools: AgentTool[];
    goal: string;
    guardrails: GuardrailConfig;
    signal: AbortSignal;
}): Promise<AgentRunResult> {
    const context: AgentContext = {
        messages: [],
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
        model: opts.model,
    };

    const config: AgentLoopConfig = {
        model: opts.model,
        convertToLlm: defaultConvertToLlm,
        beforeToolCall: makeBeforeToolCall(opts.guardrails, opts.workspace),
        afterToolCall: makeAfterToolCall(opts.guardrails),
        shouldStopAfterTurn: makeShouldStopAfterTurn(opts.guardrails, opts.workspace),
        transformContext: makeTransformContext(opts.guardrails),
    };

    const stream = agentLoop(
        [{ role: 'user', content: [{ type: 'text', text: opts.goal }] }],
        context,
        config,
        opts.signal,
        undefined, // streamFn — 用 Pi 默认的
    );

    // 消费事件流 → 写入 event log
    for await (const event of stream) {
        await appendEvent(opts.taskId, event);
        eventBus.publish(mapToForgeEvent(event));
    }

    return { messages: await stream.done() };
}
```

### 6.2 Guardrails（护栏层，~500 行新增 + ~800 行从 Forge 适配）

```typescript
// src/guardrails/before-tool-call.ts
import { evaluateToolCall, classifyCapabilities } from '../guard/policy.ts';
import { journalFile } from '../guard/journal.ts';

export function makeBeforeToolCall(config: GuardrailConfig, workspace: string) {
    return async (ctx: BeforeToolCallContext, signal?: AbortSignal) => {
        const { toolCall, args } = ctx;
        const toolName = toolCall.name;

        // 1. Guard 权限检查
        const decision = evaluateToolCall(
            loadPolicy(),
            toolName,
            args as Record<string, unknown>,
        );

        if (decision.action === 'deny') {
            return {
                block: true,
                reason: decision.reason,
                terminate: decision.terminate,
            };
        }

        // 2. Journal 备份（write/edit 工具）
        if ((toolName === 'write' || toolName === 'edit') && typeof (args as any).path === 'string') {
            await journalFile(workspace, (args as any).path);
        }

        // 3. 审批中继（ask 决策）
        if (decision.action === 'ask') {
            const approved = await config.approvalHub.request({
                taskId: config.taskId,
                toolName,
                input: args,
            });
            if (!approved) {
                return { block: true, reason: 'rejected by user' };
            }
        }

        return undefined; // 放行
    };
}
```

```typescript
// src/guardrails/stuck-detector.ts
export class StuckDetector {
    private history: AgentEvent[] = [];

    check(event: AgentEvent): StuckResult {
        this.history.push(event);

        // 1. 重复的 action-observation 对
        if (this.isRepeatingAction()) {
            return { isStuck: true, pattern: 'action_observation_loop', repetitions: this.countRepeats() };
        }

        // 2. 连续错误循环
        if (this.isErrorLoop()) {
            return { isStuck: true, pattern: 'action_error_loop' };
        }

        // 3. 无工具调用的独白
        if (this.isMonologue()) {
            return { isStuck: true, pattern: 'monologue' };
        }

        // 4. 交替模式（A→B→A→B→...）
        if (this.isAlternating()) {
            return { isStuck: true, pattern: 'alternating_pattern' };
        }

        return { isStuck: false };
    }
}
```

```typescript
// src/guardrails/cost-guard.ts
export class CostGuard {
    private spent: number = 0;
    private readonly budget: number;

    trackUsage(usage: Usage): void {
        this.spent += usage.cost.total;
    }

    isExhausted(): boolean {
        return this.spent >= this.budget;
    }
}
```

```typescript
// src/guardrails/completion-verifier.ts
import { validate } from '../verification/validate.ts';
import { DeterministicEvaluator } from '../evaluation/deterministic-evaluator.ts';

export async function verifyCompletion(
    criteria: SuccessCriterion[],
    workspace: string,
): Promise<VerifyResult> {
    const results: CriterionResult[] = [];
    for (const c of criteria) {
        results.push(await validate(c, workspace));
    }
    const allPassed = results.every(r => r.passed);
    return {
        passed: allPassed,
        results,
        reason: allPassed ? undefined : results.filter(r => !r.passed).map(r => r.message).join('; '),
    };
}
```

### 6.3 数据模型（~100 行）

```typescript
// src/types.ts
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type SessionKind = 'conversation' | 'task';

export interface Session {
    id: string;
    kind: SessionKind;
    goal: string;
    workspace: string;
    model: { provider: string; modelId: string };
    messages: AgentMessage[];     // Pi 的消息类型
    createdAt: number;
    updatedAt: number;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    failureReason: string | null;
    cost: { total: number };
    // 完成验证（可选，高信任模式）
    completionCriteria?: SuccessCriterion[];
    lastEvaluation?: EvaluationResult | null;
}

// 取代 TaskSession/Plan/PlanStep/Observation
// Session.messages 就是完整对话历史
// tool calls 和 results 是 message 的一部分
```

---

## 7. 事件流

Pi 的 `agentLoop` 返回 `EventStream<AgentEvent, AgentMessage[]>`——一个异步迭代器，yield 每个 agent 事件。

```typescript
for await (const event of stream) {
    switch (event.type) {
        case 'agent_start':    → appendEvent(taskId, 'SESSION_STARTED', {})
        case 'turn_start':     → appendEvent(taskId, 'TURN_STARTED', {})
        case 'message_start':  → appendEvent(taskId, 'MESSAGE_STARTED', { message: event.message })
        case 'text_delta':     → appendEvent(taskId, 'TEXT_DELTA', { delta: event.delta })
        case 'tool_call':      → appendEvent(taskId, 'TOOL_CALL', { tool: event.toolName, input: event.input })
        case 'tool_result':    → appendEvent(taskId, 'TOOL_RESULT', { output: event.output })
        case 'turn_end':       → appendEvent(taskId, 'TURN_ENDED', {})
        case 'agent_end':      → appendEvent(taskId, 'SESSION_ENDED', { messages: event.messages })
    }
    eventBus.publish(mapToUiEvent(event));
}
```

复用 Forge 的 `event-log.ts`（FIFO append queue + CJK 修复）。SSE stream 复用 `TaskEventStream`（replay + tail follow + seq 去重）。

---

## 8. HTTP API

从 task-centric 改为 session-centric：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /sessions | 创建 session（goal + workspace + model） |
| GET | /sessions | 列出所有 session |
| GET | /sessions/:id | 获取 session 状态 |
| GET | /sessions/:id/stream | SSE 事件流（replay + live） |
| POST | /sessions/:id/steer | 中途干预（注入 steering message） |
| POST | /sessions/:id/abort | 中止 |
| DELETE | /sessions/:id | 删除（task.json + event log + undo journal） |
| GET | /sessions/:id/diff | 获取变更 diff |
| POST | /sessions/:id/undo | 撤销变更 |
| GET | /sessions/:id/approvals | 待审批列表 |
| POST | /sessions/:id/approvals/:reqId/approve | 批准 |
| POST | /sessions/:id/approvals/:reqId/deny | 拒绝 |
| GET | /sessions/:id/effort | 获取推理强度 |
| POST | /sessions/:id/effort | 设置推理强度 |
| POST | /sessions/:id/compact | 手动压缩上下文 |
| POST | /sessions/:id/message | 继续对话 |
| POST | /sessions/:id/subscription | 切换 model |
| GET | /sessions/:id/files | 列出工作区文件 |
| POST | /sessions/:id/rename | 重命名 |

---

## 9. 信任级别

完成验证按信任级别配置：

```typescript
type TrustLevel = 'low' | 'medium' | 'high';

interface CompletionConfig {
    trustLevel: TrustLevel;
    criteria?: SuccessCriterion[];  // high 级别必配
    maxCost?: number;               // 美元预算
    maxTurns?: number;              // 最大轮次
}
```

| 级别 | shouldStopAfterTurn 行为 |
|---|---|
| low | 模型停就停。不跑验证。用于聊天/问答 |
| medium | 模型停 → 跑 `npm test` 或 `npm run build` → 过了才停 |
| high | 模型停 → 跑所有 `criteria`（validate.ts）+ evaluator 打分 → 全过才停 |

---

## 10. 目录结构

```
forge-next/
├── packages/                   ← Pi（git submodule 或 npm 依赖）
│   └── pi/                     ← @earendil-works/pi (MIT, 90K 行)
│
├── src/
│   ├── agent-runner.ts         ← 入口：Pi agentLoop + hooks 装配（~200 行）
│   ├── types.ts                ← Session/CompletionConfig 等新数据模型
│   │
│   ├── guardrails/             ← 护栏层（新 + 从 Forge 适配）
│   │   ├── before-tool-call.ts ← Guard 权限 + Journal 备份
│   │   ├── stuck-detector.ts   ← 重复模式检测（4 种）
│   │   ├── cost-guard.ts       ← 成本预算 + 熔断
│   │   └── completion-verifier.ts ← 完成验证 + evaluator
│   │
│   ├── verification/           ← 从 Forge 直接复用
│   │   ├── validate.ts
│   │   ├── command-policy.ts
│   │   └── index.ts
│   │
│   ├── guard/                  ← 从 Forge 直接复用
│   │   ├── policy.ts
│   │   ├── journal.ts
│   │   └── index.ts
│   │
│   ├── persistence/            ← 从 Forge 直接复用
│   │   ├── event-log.ts       ← FIFO append + CJK 修复
│   │   ├── session-store.ts   ← 从 task-store.ts 适配
│   │   ├── schema.ts          ← 适配新数据模型
│   │   └── json.ts
│   │
│   ├── recovery/               ← 从 Forge 直接复用 + 适配
│   │   └── recovery-service.ts
│   │
│   ├── evaluation/             ← 从 Forge 直接复用
│   │   ├── deterministic-evaluator.ts
│   │   └── evaluator.ts
│   │
│   ├── events/                 ← 从 Forge 直接复用
│   │   ├── event-bus.ts
│   │   ├── event-types.ts
│   │   └── publisher.ts
│   │
│   ├── server/                 ← 重写（conversation-centric）
│   │   ├── http-server.ts       ← 路由
│   │   ├── session-manager.ts   ← 替代 task-manager.ts
│   │   ├── undo.ts              ← 从 Forge 复用
│   │   ├── approval-hub.ts      ← 从 Forge 复用
│   │   ├── config-store.ts      ← 从 Forge 复用
│   │   ├── projects.ts          ← 从 Forge 复用
│   │   └── event-stream.ts      ← 从 Forge 复用
│   │
│   └── cli/
│       ├── serve.ts             ← 启动 server
│       └── run.ts               ← 单任务 CLI
│
├── desktop/                    ← Tauri + React（外壳保留，主视图重写）
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── SessionView.tsx    ← 重写：对话/工具调用视图
│   │   │   ├── VerificationPanel.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── ...
│   │   └── lib/
│   └── ...
│
├── benchmark/                  ← 从 Forge 复用 + 适配
│   ├── harness.ts
│   ├── metrics.ts
│   ├── golden.ts
│   ├── scripted-runtime.ts      ← 适配为 Pi 的 streamFn mock
│   └── types.ts
│
├── docs/
│   └── ARCHITECTURE.md          ← 本文档
│
├── package.json                 ← 依赖 @earendil-works/pi-agent-core + pi-ai
└── tsconfig.json
```

---

## 11. 实施计划

### 阶段 1：骨架打通（1-2 天）

**目标：Pi agentLoop 能跑，事件能流到 event log。**

- [ ] 复制 Forge 代码到新项目
- [ ] 删除 state machine + RPC 层（~1700 行）
- [ ] `package.json` 加 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` 依赖
- [ ] 写 `agent-runner.ts`：最小 AgentLoopConfig（convertToLlm + 默认 hooks）
- [ ] 写最小 `Session` 数据模型
- [ ] CLI `run.ts`：`runAgent(goal) → stream events → print`
- [ ] 验证：能跑通"创建一个 hello.txt"任务

### 阶段 2：护栏接入（2-3 天）

**目标：Guard + Journal + 事件流 + SSE。**

- [ ] `beforeToolCall` → 接入 `guard/policy.ts` + `guard/journal.ts`
- [ ] 事件流 → 接入 `event-log.ts`（FIFO append）+ `event-bus.ts`
- [ ] SSE stream → 复用 `TaskEventStream`
- [ ] `server/http-server.ts` + `session-manager.ts`：最小 session API
- [ ] 验证：Guard 拦截 write 到 workspace 外的路径

### 阶段 3：完成验证（1-2 天）

**目标：不信任"模型说做完了"。**

- [ ] `shouldStopAfterTurn` → 接入 `validate.ts` + cost guard
- [ ] `CompletionConfig`（信任级别 + criteria）
- [ ] `afterToolCall` → 接入卡住检测
- [ ] `evaluation/deterministic-evaluator.ts` → 完成后打分
- [ ] 验证：任务"做了一半"时验证不过 → agent 继续修

### 阶段 4：桌面 UI（3-5 天）

**目标：桌面端能看对话 + 工具调用 + 验证结果。**

- [ ] `SessionView` 组件：消息流 + 工具调用展开
- [ ] `VerificationPanel`：验证结果展示
- [ ] 审批 UI：Guard ask 时弹窗
- [ ] diff/undo UI
- [ ] 验证：端到端桌面体验

### 阶段 5：恢复 + 压缩（2-3 天）

**目标：崩溃能恢复，长对话能压缩。**

- [ ] `recovery-service.ts` 适配新数据模型
- [ ] `transformContext` → token 估算 + 截断
- [ ] `prepareNextTurn` → 触发 Pi 内置压缩
- [ ] 验证：kill 进程后 resume 能恢复

### 阶段 6：Benchmark 适配（1-2 天）

**目标：golden tasks 能跑。**

- [ ] `scripted-runtime.ts` 适配为 Pi 的 `streamFn` mock
- [ ] `harness.ts` 适配新 `runAgent` 入口
- [ ] `metrics.ts` 适配新 `Session` 数据模型
- [ ] 验证：golden task 全部跑通

---

## 12. 依赖关系

```json
{
  "dependencies": {
    "@earendil-works/pi-agent-core": "^1.x",
    "@earendil-works/pi-ai": "^1.x",
    "@earendil-works/pi-coding-agent": "^1.x"
  }
}
```

或者通过 git submodule 包含 Pi 源码：

```bash
git submodule add https://github.com/earendil-works/pi packages/pi
```

---

## 13. 与 Forge 的对比

| | Forge（旧） | Forge Next |
|---|---|---|
| 大脑 | 状态机（7 状态） | LLM（Pi agentLoop） |
| 主循环 | `runOrchestratorLoop` switch-case | Pi `agentLoop` while-loop |
| 与 Pi 关系 | subprocess + NDJSON RPC | in-process import |
| 护栏位置 | 外层循环（EXECUTE → OBSERVE → FIX） | AgentLoopConfig hooks（beforeToolCall 等） |
| 验证 | OBSERVE 状态强制跑 criteria | shouldStopAfterTurn 按信任级别可选 |
| 规划 | LlmPlanner 生成 JSON plan | LLM 自己规划 |
| 修复 | FIX 状态 + decideFix 模板 | LLM 自己看 tool result 修 |
| 上下文 | 每步新 prompt，无历史 | Pi 对话历史 + 压缩 |
| 工具 | Pi 黑箱 | Pi 透明（hooks 可见） |
| 事件流 | orchestrator 不消费 | agent-runner 消费 → event log + SSE |
| 完成判断 | 验证通过 + evaluator | 信任级别配置（low/medium/high） |
| 恢复 | 基于 task state + event log | 基于 session + event log |
| 代码量 | ~100 文件（含状态机 ~4400 行） | ~60 文件（删 ~4400 行，加 ~800 行护栏） |

---

## 14. 设计原则

1. **LLM 是大脑。** 不在 LLM 上面包状态机。护栏是回调，不是循环。

2. **不信任"做完了"。** shouldStopAfterTurn 按信任级别验证完成。这是 Forge 的核心价值，必须保留。

3. **护栏通过 hooks 注入。** 不写独立的 orchestrator。Pi 的 AgentLoopConfig 就是集成点。

4. **Pi in-process。** 不再 subprocess RPC。进程内 import，直接调函数。

5. **保留好的护栏代码。** validate.ts、command-policy.ts、policy.ts、journal.ts、event-log.ts 直接复用。

6. **不追求 OpenCC 的规模。** 先做对（agent loop + 护栏），再做全（更多工具、更智能记忆、更多压缩策略）。

7. **每个阶段独立可验证。** 阶段 1 能跑通基础任务就交付，不等"全部做完"。

---

## 15. 决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-09-08 | LLM 驱动主循环，删除状态机 | SWE-agent/OpenHands/OpenCC 三个项目全部 LLM 驱动 |
| 2026-09-08 | Pi in-process import，不再 subprocess | 消除两个-loop 问题，hooks 直接注入 |
| 2026-09-08 | 护栏通过 AgentLoopConfig hooks 注入 | Pi 已有 beforeToolCall/afterToolCall/shouldStopAfterTurn |
| 2026-09-08 | 保留 Forge 的验证器/guard/journal/event-log/recovery | 代码质量 B+，直接复用省时间 |
| 2026-09-08 | 完成验证按信任级别配置 | 简单任务不过度验证，复杂任务必须验证 |
| 2026-09-08 | 复制 Forge 代码改造，不从零开始 | 护栏代码 + 桌面壳 + benchmark 值得保留 |
