# Forge Next 实施指引

> 执行级文档。给 AI 编码 agent 用，每步可验证。

---

## 0. 前置条件

- Pi 源码在 `packages/pi/`（git submodule 或 npm 安装）
- Node.js 22+ 或 Bun
- Rust（Tauri v2 编译用）
- 旧 Forge 代码在同级目录（作为复制源）

---

## 1. 项目初始化

### 1.1 package.json

```json
{
  "name": "forge-next",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/cli/serve.ts --port 5300",
    "run": "tsx src/cli/run.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "bench": "tsx src/cli/benchmark.ts"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "^0.85.1",
    "@earendil-works/pi-ai": "^0.85.1",
    "@earendil-works/pi-coding-agent": "^0.85.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.22.0",
    "typescript": "^5.9.0"
  }
}
```

### 1.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "paths": {
      "@forge/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "packages", "desktop", "benchmark"]
}
```

### 1.3 安装 Pi

```bash
# 方式 A：git submodule
git submodule add https://github.com/earendil-works/pi packages/pi
cd packages/pi && npm install --ignore-scripts && npm run build

# 方式 B：npm
npm install @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent
```

### 验收

```bash
npx tsc --noEmit  # 能通过（可能有 Pi 类型错误，忽略 Pi 自己的）
```

---

## 2. 从旧 Forge 复制文件

### 2.1 直接复制（不改或只改 import 路径）

```bash
# 护栏
cp old-forge/src/verification/validate.ts      src/verification/validate.ts
cp old-forge/src/verification/command-policy.ts src/verification/command-policy.ts
cp old-forge/src/guard/policy.ts              src/guard/policy.ts
cp old-forge/src/guard/journal.ts             src/guard/journal.ts

# 持久化
cp old-forge/src/core/persistence/event-log.ts src/persistence/event-log.ts
cp old-forge/src/core/persistence/json.ts      src/persistence/json.ts
cp old-forge/src/core/persistence/schema.ts     src/persistence/schema.ts

# 评估
cp old-forge/src/evaluation/deterministic-evaluator.ts src/evaluation/deterministic-evaluator.ts
cp old-forge/src/evaluation/evaluator.ts               src/evaluation/evaluator.ts

# 恢复
cp old-forge/src/recovery/recovery-service.ts src/recovery/recovery-service.ts

# 服务端复用
cp old-forge/src/server/undo.ts               src/server/undo.ts
cp old-forge/src/server/approval-hub.ts       src/server/approval-hub.ts
cp old-forge/src/server/config-store.ts        src/server/config-store.ts
cp old-forge/src/server/projects.ts            src/server/projects.ts
cp old-forge/src/server/event-stream.ts        src/server/event-stream.ts

# 事件
cp old-forge/src/events/event-bus.ts           src/events/event-bus.ts
cp old-forge/src/events/publisher.ts            src/events/publisher.ts

# 类型
cp old-forge/src/core/types/criterion.ts        src/types/criterion.ts
cp old-forge/src/core/types/evaluation.ts       src/types/evaluation.ts
```

### 2.2 需要改 import 的文件

**event-log.ts**：`taskId` → `sessionId`（全局替换）

**schema.ts**：添加 v3→v4 迁移（TaskSession → Session）

**command-policy.ts**：`guard/policy.ts` 的 import 路径确认正确

### 2.3 不复制的文件

```
# 状态机（全删）
orchestrator/engine.ts
orchestrator/llm-planner.ts
orchestrator/planner.ts
orchestrator/scheduler.ts
orchestrator/fix-decision.ts
orchestrator/instruction.ts
orchestrator/plan-ops.ts
orchestrator/runner.ts
orchestrator/retry-policy.ts
core/state/task-state.ts

# RPC 层（全删）
runtime/pi/pi-adapter.ts
runtime/pi/pi-rpc-client.ts
runtime/pi/pi-process.ts
runtime/pi/pi-paths.ts
runtime/interface.ts
runtime/fake-runtime.ts

# 旧数据模型
core/types/plan.ts
core/types/step.ts
core/types/task-session.ts

# 旧服务端
server/task-manager.ts
server/http-server.ts
server/intent-router.ts

# Skills
skills/  （整个目录）
```

### 验收

```bash
# 文件存在
ls src/verification/validate.ts src/guard/policy.ts src/persistence/event-log.ts
# 文件不存在
test ! -f src/orchestrator/engine.ts && echo "OK: state machine deleted"
test ! -f src/runtime/pi/pi-adapter.ts && echo "OK: RPC deleted"
```

---

## 3. 新数据模型

### 3.1 src/types.ts

```typescript
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SuccessCriterion } from "./types/criterion.ts";
import type { EvaluationResult } from "./types/evaluation.ts";

export type SessionKind = "conversation" | "task";
export type SessionStatus = "running" | "completed" | "failed" | "cancelled";
export type TrustLevel = "low" | "medium" | "high";

export interface Session {
  id: string;
  kind: SessionKind;
  goal: string;
  workspace: string;
  projectId: string | null;
  model: { provider: string; modelId: string; effort?: string };
  messages: AgentMessage[];
  status: SessionStatus;
  failureReason: string | null;
  cost: { total: number; budget: number | null };
  trustLevel: TrustLevel;
  completionCriteria: SuccessCriterion[];
  lastEvaluation: EvaluationResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompletionConfig {
  trustLevel: TrustLevel;
  criteria: SuccessCriterion[];
  maxCost: number | null;
  maxTurns: number | null;
}

export interface GuardrailConfig {
  sessionId: string;
  workspace: string;
  completion: CompletionConfig;
  approvalHub: ApprovalHub;
  steeringQueue: AgentMessage[];
}

// 从旧 Forge 复制的类型
export type { SuccessCriterion, CriterionResult } from "./types/criterion.ts";
export type { EvaluationResult, Finding, Evidence } from "./types/evaluation.ts";
```

### 3.2 src/persistence/session-store.ts

```typescript
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../types.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json.ts";
import { stampSchemaVersion, migrateSession } from "./schema.ts";

export const SESSIONS_DIR = resolve(
  process.env.FORGE_SESSIONS_DIR ??
    join(process.env.HOME ?? "/tmp", ".forge", "sessions"),
);

export async function saveSession(session: Session): Promise<void> {
  await writeJsonFileAtomic(
    join(SESSIONS_DIR, `${session.id}.json`),
    stampSchemaVersion(session as unknown as Record<string, unknown>) as unknown as Session,
  );
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const raw = await readJsonFile<Record<string, unknown>>(join(SESSIONS_DIR, `${id}.json`));
    return migrateSession(raw) as unknown as Session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const entries = await readdir(SESSIONS_DIR);
    const out: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readJsonFile<Record<string, unknown>>(join(SESSIONS_DIR, entry));
        out.push(migrateSession(raw) as unknown as Session);
      } catch { continue; }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

export async function deleteSession(id: string): Promise<void> {
  await rm(join(SESSIONS_DIR, `${id}.json`), { force: true });
}
```

### 3.3 schema.ts 迁移（在旧 schema.ts 基础上添加 v4）

```typescript
export const SESSION_SCHEMA_VERSION = 4;

// v3→v4: TaskSession → Session
// 字段映射: state → status, plan/observations → 删除(用 messages), fixCount → 删除
{
  from: 3,
  to: 4,
  migrate: (raw) => ({
    ...raw,
    status: mapTaskStateToSessionStatus(raw.state),
    messages: raw.messages ?? [],
    cost: { total: 0, budget: null },
    trustLevel: "medium",
    completionCriteria: [],
    // 删除旧字段
    state: undefined,
    plan: undefined,
    observations: undefined,
    fixCount: undefined,
    currentStepId: undefined,
    runtime: undefined,
    piSessionId: undefined,
  }),
}
```

### 验收

```typescript
// test: 能保存和加载 session
const session: Session = { id: "test", kind: "task", goal: "test", workspace: "/tmp", ... };
await saveSession(session);
const loaded = await loadSession("test");
assert(loaded?.goal === "test");
```

---

## 4. AgentRunner（入口）

### 4.1 src/agent-runner.ts

```typescript
import {
  agentLoop,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import type { Model, Context } from "@earendil-works/pi-ai";
import { createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./persistence/event-log.ts";
import { EventBus } from "./events/event-bus.ts";
import { makeBeforeToolCall } from "./guardrails/before-tool-call.ts";
import { makeAfterToolCall } from "./guardrails/after-tool-call.ts";
import { makeShouldStopAfterTurn } from "./guardrails/should-stop-after-turn.ts";
import { makeTransformContext } from "./guardrails/transform-context.ts";
import type { Session, GuardrailConfig } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Context["messages"] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}

function createDefaultTools(workspace: string): AgentTool<any>[] {
  // Pi 的内置工具
  // 具体 create 函数签名见 packages/coding-agent/src/core/tools/index.ts
  // 需要 cwd/extension 参数，查 Pi 源码确认
  return [
    // createReadTool(workspace),
    // createBashTool(workspace),
    // createWriteTool(workspace),
    // createEditTool(workspace),
    // createGrepTool(workspace),
    // createFindTool(workspace),
    // createLsTool(workspace),
  ];
}

export async function runAgent(opts: {
  session: Session;
  model: Model<any>;
  guardrails: GuardrailConfig;
  eventBus: EventBus;
  signal: AbortSignal;
}): Promise<Session> {
  const { session, model, guardrails, eventBus, signal } = opts;

  const context: AgentContext = {
    systemPrompt: buildSystemPrompt(session),
    messages: session.messages,
    tools: createDefaultTools(session.workspace),
  };

  const config: AgentLoopConfig = {
    model,
    convertToLlm: defaultConvertToLlm,
    beforeToolCall: makeBeforeToolCall(guardrails),
    afterToolCall: makeAfterToolCall(guardrails),
    shouldStopAfterTurn: makeShouldStopAfterTurn(guardrails, session.workspace),
    transformContext: makeTransformContext(),
    getSteeringMessages: async () => {
      const msgs = guardrails.steeringQueue.splice(0);
      return msgs;
    },
  };

  // 初始 prompt
  const prompts: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: session.goal }] },
  ];

  // 启动 agent loop
  const stream = agentLoop(prompts, context, config, signal, undefined);

  // 消费事件流
  for await (const event of stream) {
    await handleAgentEvent(session.id, event, eventBus);
  }

  // 获取最终消息
  const finalMessages = await stream.result();
  session.messages = finalMessages;

  return session;
}

async function handleAgentEvent(
  sessionId: string,
  event: AgentEvent,
  bus: EventBus,
): Promise<void> {
  // 写入 event log（复用 Forge 的 FIFO append）
  const mapped = mapAgentEventToPersisted(event);
  if (mapped) {
    await appendEvent(sessionId, mapped.type, mapped.payload);
  }

  // 推送到 event bus → SSE → UI
  bus.publish(mapAgentEventToUiEvent(event));
}

function buildSystemPrompt(session: Session): string {
  return [
    "You are Forge's engineering agent working in the user's project.",
    `Working directory: ${session.workspace}`,
    "",
    "Use tools to read, write, edit files and run commands.",
    "When you're done, stop calling tools.",
  ].join("\n");
}
```

### 4.2 Pi AgentEvent → Forge 事件映射

```typescript
// src/events/mapper.ts
import type { AgentEvent } from "@earendil-works/pi-agent-core";

export function mapAgentEventToPersisted(
  event: AgentEvent,
): { type: string; payload: Record<string, unknown> } | null {
  switch (event.type) {
    case "agent_start":
      return { type: "SESSION_STARTED", payload: {} };
    case "agent_end":
      return { type: "SESSION_ENDED", payload: { messages: event.messages.length } };
    case "turn_start":
      return { type: "TURN_STARTED", payload: {} };
    case "turn_end":
      return { type: "TURN_ENDED", payload: { toolResults: event.toolResults.length } };
    case "message_start":
      return { type: "MESSAGE_STARTED", payload: { message: event.message } };
    case "message_update":
      return { type: "MESSAGE_UPDATED", payload: { message: event.message, delta: event.assistantMessageEvent } };
    case "message_end":
      return { type: "MESSAGE_ENDED", payload: { message: event.message } };
    case "tool_execution_start":
      return { type: "TOOL_CALL", payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args } };
    case "tool_execution_update":
      return { type: "TOOL_UPDATE", payload: { toolCallId: event.toolCallId, partialResult: event.partialResult } };
    case "tool_execution_end":
      return { type: "TOOL_RESULT", payload: { toolCallId: event.toolCallId, result: event.result, isError: event.isError } };
    default:
      return null;
  }
}

export function mapAgentEventToUiEvent(event: AgentEvent): ForgeUiEvent {
  // 映射为 UI 可消费的事件类型
  // 包括 agent 事件 + 护栏事件（GUARD_APPROVAL_REQUEST 等）
  // 具体类型见 event-types.ts
  return mapAgentEventToPersisted(event) as ForgeUiEvent;
}
```

### 验收

```bash
# CLI 测试
npx tsx src/cli/run.ts "create a file hello.txt with content 'world'"
# 预期：hello.txt 被创建，事件打印到 stdout
```

---

## 5. 护栏层

### 5.1 src/guardrails/before-tool-call.ts

```typescript
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { evaluateToolCall, loadPolicy } from "../guard/policy.ts";
import { journalFile } from "../guard/journal.ts";
import type { GuardrailConfig } from "../types.ts";

export function makeBeforeToolCall(config: GuardrailConfig) {
  return async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const { toolCall, args } = ctx;
    const toolName = toolCall.name;
    const input = (args ?? {}) as Record<string, unknown>;

    // 1. Guard 权限检查
    const decision = evaluateToolCall(loadPolicy(), toolName, input);

    if (decision.action === "deny") {
      return {
        block: true,
        reason: decision.reason,
        terminate: decision.terminate,
      };
    }

    // 2. Journal 备份（write/edit 工具）
    if (
      (toolName === "write" || toolName === "edit") &&
      typeof input.path === "string"
    ) {
      await journalFile(config.workspace, input.path);
    }

    // 3. 审批中继（ask 决策）
    if (decision.action === "ask") {
      const approved = await config.approvalHub.request({
        requestId: toolCall.id,
        sessionId: config.sessionId,
        toolName,
        input,
      });
      if (!approved) {
        return { block: true, reason: "rejected by user" };
      }
    }

    return undefined; // 放行
  };
}
```

### 5.2 src/guardrails/after-tool-call.ts

```typescript
import type {
  AfterToolCallContext,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";
import { StuckDetector } from "./stuck-detector.ts";
import type { GuardrailConfig } from "../types.ts";

export function makeAfterToolCall(config: GuardrailConfig) {
  const stuckDetector = new StuckDetector();

  return async (
    ctx: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined> => {
    const { toolCall, result, isError } = ctx;

    // 卡住检测
    stuckDetector.track({
      toolName: toolCall.name,
      args: ctx.args,
      result: result.details,
      isError,
    });

    const stuck = stuckDetector.check();
    if (stuck.isStuck) {
      // 可以注入 steering 或直接 terminate
      return { terminate: true };
    }

    return undefined;
  };
}
```

### 5.3 src/guardrails/should-stop-after-turn.ts

```typescript
import type { ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import { validate } from "../verification/validate.ts";
import { DeterministicEvaluator } from "../evaluation/deterministic-evaluator.ts";
import type { GuardrailConfig, Session } from "../types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function makeShouldStopAfterTurn(
  config: GuardrailConfig,
  workspace: string,
) {
  const evaluator = new DeterministicEvaluator();
  let turnCount = 0;
  // Error recovery counters (参考 Claude Code 的恢复式状态机)
  const recoveryCounts = new Map<string, number>();
  const MAX_RECOVERY = 3;

  return async (ctx: ShouldStopAfterTurnContext): Promise<boolean> => {
    turnCount++;

    // 0. 错误恢复（透明，参考 Claude Code 的 error withholding 模式）
    const stopReason = (ctx.message as any)?.stopReason ?? "";
    const content = (ctx.message as any)?.content ?? [];

    // 输出被截断 → inject steering 让模型继续
    if (stopReason === "max_tokens" || stopReason === "length") {
      const count = (recoveryCounts.get("max_tokens") ?? 0) + 1;
      recoveryCounts.set("max_tokens", count);
      if (count <= MAX_RECOVERY) {
        config.steeringQueue.push({
          role: "user",
          content: [{ type: "text", text: "Your output was truncated. Continue from where you left off." }],
        } as AgentMessage);
        return false; // 不停，继续
      }
    }

    // 空响应 → 重试
    if (Array.isArray(content) && content.length === 0) {
      const count = (recoveryCounts.get("empty") ?? 0) + 1;
      recoveryCounts.set("empty", count);
      if (count <= MAX_RECOVERY) {
        config.steeringQueue.push({
          role: "user",
          content: [{ type: "text", text: "Your last response was empty. Please try again." }],
        } as AgentMessage);
        return false;
      }
    }

    // 1. 成本预算
    if (config.completion.maxCost !== null) {
      // 从 ctx.context 或 usage 追踪成本
    }

    // 2. 轮次限制
    if (config.completion.maxTurns !== null && turnCount >= config.completion.maxTurns) {
      return true;
    }

    // 3. 完成验证（按信任级别）
    const { trustLevel, criteria } = config.completion;

    if (trustLevel === "low") {
      return false; // 模型说停就停
    }

    if (trustLevel === "medium") {
      const results = await validate(
        { kind: "command_exit_zero", command: "npm test" },
        workspace,
      );
      if (!results.passed) {
        config.steeringQueue.push({
          role: "user",
          content: [{ type: "text", text: `npm test failed: ${results.message}. Please fix and try again.` }],
        } as AgentMessage);
        return false;
      }
      return true;
    }

    if (trustLevel === "high") {
      let allPassed = true;
      for (const c of criteria) {
        const result = await validate(c, workspace);
        if (!result.passed) {
          allPassed = false;
          config.steeringQueue.push({
            role: "user",
            content: [{ type: "text", text: `Verification failed: ${result.message}. Please fix.` }],
          } as AgentMessage);
        }
      }
      if (!allPassed) return false;

      const evalResult = await evaluator.evaluate({
        task: { id: config.sessionId, goal: "", state: "running", plan: null, observations: [], fixCount: 0, model: { provider: "", modelId: "" }, createdAt: 0, updatedAt: 0, failureReason: null, lastEvaluation: null } as any,
        plan: null,
        observations: [],
        memory: [],
      });
      return evalResult.status !== "REVIEW_REQUIRED";
    }

    return false;
  };
}
```

### 5.4 src/guardrails/stuck-detector.ts

```typescript
export interface StuckThresholds {
  actionObservation: number;  // default 4
  actionError: number;        // default 4
  monologue: number;          // default 4
  alternatingPattern: number; // default 6
}

const DEFAULT_THRESHOLDS: StuckThresholds = {
  actionObservation: 4,
  actionError: 4,
  monologue: 4,
  alternatingPattern: 6,
};

interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

export class StuckDetector {
  private history: ToolCallRecord[] = [];
  private thresholds: StuckThresholds;

  constructor(thresholds?: Partial<StuckThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  track(record: ToolCallRecord): void {
    this.history.push(record);
    if (this.history.length > 50) this.history.shift();
  }

  check(): { isStuck: boolean; pattern?: string; repetitions?: number } {
    // 1. 重复 action-observation 对
    const lastObs = this.history.slice(-this.thresholds.actionObservation);
    if (lastObs.length >= this.thresholds.actionObservation) {
      const allSame = lastObs.every(
        (r) =>
          r.toolName === lastObs[0]!.toolName &&
          JSON.stringify(r.args) === JSON.stringify(lastObs[0]!.args) &&
          !r.isError,
      );
      if (allSame) {
        return { isStuck: true, pattern: "action_observation_loop", repetitions: lastObs.length };
      }
    }

    // 2. 重复 action-error 对
    const lastErrors = this.history.slice(-this.thresholds.actionError);
    if (lastErrors.length >= this.thresholds.actionError) {
      const allSameError = lastErrors.every(
        (r) =>
          r.toolName === lastErrors[0]!.toolName &&
          JSON.stringify(r.args) === JSON.stringify(lastErrors[0]!.args) &&
          r.isError,
      );
      if (allSameError) {
        return { isStuck: true, pattern: "action_error_loop", repetitions: lastErrors.length };
      }
    }

    // 3. 交替模式 A→B→A→B
    if (this.history.length >= this.thresholds.alternatingPattern) {
      const recent = this.history.slice(-this.thresholds.alternatingPattern);
      const a = JSON.stringify({ tool: recent[0]!.toolName, args: recent[0]!.args });
      const b = JSON.stringify({ tool: recent[1]!.toolName, args: recent[1]!.args });
      if (a !== b) {
        const alternating = recent.every((r, i) => {
          const expected = i % 2 === 0 ? a : b;
          return JSON.stringify({ tool: r.toolName, args: r.args }) === expected;
        });
        if (alternating) {
          return { isStuck: true, pattern: "alternating_pattern", repetitions: recent.length };
        }
      }
    }

    return { isStuck: false };
  }
}
```

### 5.5 src/guardrails/cost-guard.ts

```typescript
import type { Usage } from "@earendil-works/pi-ai";

export class CostGuard {
  private spent: number = 0;
  private readonly budget: number | null;

  constructor(budget: number | null) {
    this.budget = budget;
  }

  trackUsage(usage: Usage): void {
    this.spent += usage.cost.total;
  }

  isExhausted(): boolean {
    if (this.budget === null) return false;
    return this.spent >= this.budget;
  }

  getSpent(): number {
    return this.spent;
  }

  getRemaining(): number | null {
    if (this.budget === null) return null;
    return Math.max(0, this.budget - this.spent);
  }
}
```

### 5.6 src/guardrails/transform-context.ts

```typescript
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const MAX_CONTEXT_TOKENS = 100_000; // 近似值，按字符数估算
const CHARS_PER_TOKEN = 4; // 近似值

function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function makeTransformContext() {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const tokens = estimateTokens(messages);
    if (tokens <= MAX_CONTEXT_TOKENS) return messages;

    // 简单截断：保留 system prompt + 最近 N 条消息
    // 未来替换为 Pi 的 compaction
    const truncated = messages.slice(-20); // 保留最近 20 条
    return truncated;
  };
}
```

### 验收

```bash
# 测试 Guard 拦截
npx tsx src/cli/run.ts "write to /etc/passwd"
# 预期：Guard deny + terminate

# 测试 Journal 备份
npx tsx src/cli/run.ts "create hello.txt"
# 预期：~/.forge/undo/<sessionId>/journal.jsonl 有备份记录

# 测试验证
npx tsx src/cli/run.ts --trust high --criteria 'file_exists:hello.txt' "create hello.txt"
# 预期：创建后验证 file_exists → pass → done
```

---

## 6. HTTP API + Session Manager

### 6.1 src/server/session-manager.ts

```typescript
import type { AgentRuntime } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { EventBus } from "../events/event-bus.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { saveSession, loadSession, listSessions, deleteSession } from "../persistence/session-store.ts";
import { appendEvent } from "../persistence/event-log.ts";
import { runAgent } from "../agent-runner.ts";
import type { Session, TrustLevel, CompletionConfig } from "../types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type ActiveEntry = {
  sessionId: string;
  runPromise: Promise<Session>;
  controller: AbortController;
  steeringQueue: AgentMessage[];
};

export class SessionManager {
  private active = new Map<string, ActiveEntry>();
  private idle = new Map<string, ActiveEntry>();

  constructor(
    private readonly opts: {
      bus: EventBus;
      forgeHome: string;
      projects: ProjectsRegistry;
      approvalHub: ApprovalHub;
    },
  ) {}

  async create(input: {
    goal: string;
    projectId?: string;
    trustLevel: TrustLevel;
    criteria?: import("../types/criterion.ts").SuccessCriterion[];
    maxCost?: number;
    maxTurns?: number;
    model: Model<any>;
  }): Promise<{ sessionId: string }> {
    // 1. 解析 workspace
    const project = input.projectId
      ? await this.opts.projects.get(input.projectId)
      : await this.opts.projects.active();
    const workspace = project?.path ?? `${this.opts.forgeHome}/sessions`;

    // 2. 创建 session
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const session: Session = {
      id: sessionId,
      kind: "task",
      goal: input.goal,
      workspace,
      projectId: project?.id ?? null,
      model: { provider: input.model.provider, modelId: input.model.id },
      messages: [],
      status: "running",
      failureReason: null,
      cost: { total: 0, budget: input.maxCost ?? null },
      trustLevel: input.trustLevel,
      completionCriteria: input.criteria ?? [],
      lastEvaluation: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSession(session);

    // 3. 启动 agent
    const steeringQueue: AgentMessage[] = [];
    const controller = new AbortController();
    const completion: CompletionConfig = {
      trustLevel: input.trustLevel,
      criteria: input.criteria ?? [],
      maxCost: input.maxCost ?? null,
      maxTurns: input.maxTurns ?? null,
    };

    const runPromise = runAgent({
      session,
      model: input.model,
      guardrails: {
        sessionId,
        workspace,
        completion,
        approvalHub: this.opts.approvalHub,
        steeringQueue,
      },
      eventBus: this.opts.bus,
      signal: controller.signal,
    }).then((final) => {
      this.settle(sessionId, final);
      return final;
    });

    void runPromise.catch(() => {});

    this.active.set(sessionId, {
      sessionId,
      runPromise,
      controller,
      steeringQueue,
    });

    return { sessionId };
  }

  async steer(sessionId: string, message: string): Promise<{ ok: boolean }> {
    const entry = this.active.get(sessionId);
    if (!entry) return { ok: false };
    entry.steeringQueue.push({
      role: "user",
      content: [{ type: "text", text: message }],
    } as AgentMessage);
    return { ok: true };
  }

  async abort(sessionId: string): Promise<{ ok: boolean }> {
    const entry = this.active.get(sessionId);
    if (!entry) return { ok: false };
    entry.controller.abort();
    return { ok: true };
  }

  async get(sessionId: string): Promise<Session | null> {
    return loadSession(sessionId);
  }

  async list(): Promise<Session[]> {
    return listSessions();
  }

  async delete(sessionId: string): Promise<{ ok: boolean }> {
    if (this.active.has(sessionId)) return { ok: false };
    await deleteSession(sessionId);
    // 删除 event log + undo journal
    return { ok: true };
  }

  listApprovals(sessionId: string) {
    return this.opts.approvalHub.listPending(sessionId);
  }

  async approve(sessionId: string, requestId: string, always = false): Promise<{ ok: boolean }> {
    // 复用旧 Forge 的 approval 逻辑
    // approvalHub.mark(requestId, "approved")
    return { ok: true };
  }

  async deny(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  private settle(sessionId: string, final: Session): void {
    const entry = this.active.get(sessionId);
    if (entry) {
      this.active.delete(sessionId);
      this.idle.set(sessionId, entry);
    }
    final.status = final.failureReason ? "failed" : "completed";
    final.updatedAt = Date.now();
    saveSession(final);
  }
}
```

### 6.2 src/server/http-server.ts

```typescript
import { createServer, type Server } from "node:http";
import { EventBus } from "../events/event-bus.ts";
import { SessionManager } from "./session-manager.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { RuntimeSupervisor } from "./runtime-supervisor.ts";
import { streamDurableEvents } from "./event-stream.ts";
import { computeDiff, restoreUndo } from "./undo.ts";
import { readEvents } from "../persistence/event-log.ts";

export async function startServer(opts: {
  port: number;
  host: string;
  forgeHome: string;
}): Promise<{ url: string; port: number; token: string; close: () => Promise<void> }> {
  const bus = new EventBus();
  const supervisor = new RuntimeSupervisor((m) => console.log(`[supervisor] ${m}`));
  const projects = new ProjectsRegistry(opts.forgeHome);
  const approvalHub = new ApprovalHub();
  const manager = new SessionManager({ bus, forgeHome: opts.forgeHome, projects, approvalHub });
  const token = generateToken();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // CORS + auth
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (!isAuthorized(req, url, token)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }

    // --- Session routes ---
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readBody(req);
      const { sessionId } = await manager.create({
        goal: body.goal,
        projectId: body.projectId,
        trustLevel: body.trustLevel ?? "medium",
        criteria: body.criteria,
        maxCost: body.maxCost,
        maxTurns: body.maxTurns,
        model: await resolveModel(body, opts.forgeHome),
      });
      json(res, 202, { sessionId });
      return;
    }

    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
      json(res, 200, { sessions: await manager.list() });
      return;
    }

    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 2) {
      const session = await manager.get(parts[1]!);
      if (!session) { json(res, 404, { error: "not found" }); return; }
      json(res, 200, session);
      return;
    }

    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "stream") {
      await streamDurableEvents(req, res, opts.forgeHome, parts[1]!);
      return;
    }

    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "steer") {
      const body = await readBody(req);
      const result = await manager.steer(parts[1]!, body.message ?? "");
      json(res, result.ok ? 200 : 409, result);
      return;
    }

    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "abort") {
      const result = await manager.abort(parts[1]!);
      json(res, result.ok ? 202 : 409, result);
      return;
    }

    if (req.method === "DELETE" && parts[0] === "sessions" && parts.length === 2) {
      const result = await manager.delete(parts[1]!);
      json(res, result.ok ? 200 : 409, result);
      return;
    }

    // --- Approvals ---
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "approvals") {
      json(res, 200, { approvals: manager.listApprovals(parts[1]!) });
      return;
    }

    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "approvals" && (parts[4] === "approve" || parts[4] === "deny")) {
      const body = await readBody(req);
      const result = parts[4] === "approve"
        ? await manager.approve(parts[1]!, parts[3]!, body.always === true)
        : await manager.deny(parts[1]!, parts[3]!);
      json(res, result.ok ? 200 : 404, result);
      return;
    }

    // --- Diff + Undo ---
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "diff") {
      const session = await manager.get(parts[1]!);
      if (!session) { json(res, 404, { error: "not found" }); return; }
      const diff = await computeDiff(opts.forgeHome, parts[1]!, session.workspace);
      json(res, 200, diff);
      return;
    }

    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "undo") {
      const result = await restoreUndo(opts.forgeHome, parts[1]!);
      json(res, 200, { ok: true, ...result });
      return;
    }

    // --- Projects ---
    if (req.method === "POST" && url.pathname === "/projects") {
      const body = await readBody(req);
      const project = await projects.register({ path: body.path, name: body.name });
      json(res, 201, project);
      return;
    }

    if (req.method === "GET" && url.pathname === "/projects") {
      json(res, 200, await projects.list());
      return;
    }

    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  return {
    url: `http://${opts.host}:${opts.port}`,
    port: opts.port,
    token,
    close: async () => { server.close(); },
  };
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c: string) => (buf += c));
    req.on("end", () => {
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
  });
}
```

### 验收

```bash
# 启动 server
npx tsx src/cli/serve.ts --port 5300

# 创建 session
curl -X POST http://localhost:5300/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"goal":"create hello.txt","trustLevel":"low"}'

# 获取 SSE 流
curl http://localhost:5300/sessions/<id>/stream?token=<token>

# 中止
curl -X POST http://localhost:5300/sessions/<id>/abort -H "Authorization: Bearer <token>"
```

---

## 7. Desktop UI 组件规格

### 7.1 状态管理（SSE 驱动）

```typescript
// desktop/src/lib/useDesktopStore.ts
import { create } from "zustand";
import type { Session } from "../../src/types.ts";
import type { ForgeUiEvent } from "./eventClient.ts";

interface DesktopState {
  sessions: Session[];
  activeSession: Session | null;
  events: ForgeUiEvent[];
  pendingApproval: ApprovalRequest | null;
  costSpent: number;
  costBudget: number | null;
  stuckWarning: StuckWarning | null;
  connect: (url: string) => void;
  createSession: (input: CreateInput) => void;
  steer: (message: string) => void;
  abort: () => void;
  approve: (requestId: string) => void;
  deny: (requestId: string) => void;
  undo: () => void;
}

export const useDesktopStore = create<DesktopState>((set, get) => ({
  sessions: [],
  activeSession: null,
  events: [],
  pendingApproval: null,
  costSpent: 0,
  costBudget: null,
  stuckWarning: null,

  connect: (url) => {
    const es = new EventSource(`${url}/sessions/${get().activeSession?.id}/stream?token=...`);
    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as ForgeUiEvent;
      // 按事件类型更新状态
      switch (event.type) {
        case "SESSION_STARTED":
        case "SESSION_ENDED":
        case "TURN_STARTED":
        case "TURN_ENDED":
        case "TEXT_DELTA":
        case "TOOL_CALL":
        case "TOOL_RESULT":
          set({ events: [...get().events, event] });
          break;
        case "GUARD_APPROVAL_REQUEST":
          set({ pendingApproval: event.payload });
          break;
        case "VERIFICATION_RESULT":
          set({ /* 更新验证面板 */ });
          break;
        case "COST_UPDATE":
          set({ costSpent: event.payload.spent });
          break;
        case "STUCK_WARNING":
          set({ stuckWarning: event.payload });
          break;
      }
    };
  },

  createSession: async (input) => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const { sessionId } = await res.json();
    // 连接 SSE
    get().connect(baseUrl);
  },

  steer: async (message) => {
    await fetch(`${baseUrl}/sessions/${get().activeSession?.id}/steer`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
  },

  abort: async () => {
    await fetch(`${baseUrl}/sessions/${get().activeSession?.id}/abort`, {
      method: "POST",
      headers: headers(),
    });
  },

  approve: async (requestId) => {
    await fetch(`${baseUrl}/sessions/${get().activeSession?.id}/approvals/${requestId}/approve`, {
      method: "POST",
      headers: headers(),
    });
    set({ pendingApproval: null });
  },

  deny: async (requestId) => {
    await fetch(`${baseUrl}/sessions/${get().activeSession?.id}/approvals/${requestId}/deny`, {
      method: "POST",
      headers: headers(),
    });
    set({ pendingApproval: null });
  },

  undo: async () => {
    await fetch(`${baseUrl}/sessions/${get().activeSession?.id}/undo`, {
      method: "POST",
      headers: headers(),
    });
  },
}));
```

### 7.2 组件清单 + Props

```typescript
// App.tsx — 主布局
// Props: 无（从 store 获取状态）
// 渲染: <Sidebar /> + <main>{activeSession ? <SessionView /> : <ProjectsPage />}</main>

// Sidebar.tsx — 项目选择 + 会话列表
// Props: { sessions, activeSessionId, onSelectSession, onCreateSession }
// 渲染: 项目列表 + session 列表 + "New Session" 按钮

// Composer.tsx — 输入 + 创建会话
// Props: { onCreate: (goal, trustLevel, criteria?) => void }
// 渲染: <textarea goal> + <select trustLevel> + <button create>

// SessionView.tsx — 对话流 + 工具调用
// Props: { events: ForgeUiEvent[], status: string }
// 消费: TEXT_DELTA → 流式渲染文本
//        TOOL_CALL → 展开工具名 + 参数
//        TOOL_RESULT → 展开结果 + 错误标记
//        MESSAGE_STARTED/ENDED → 消息边界
// 渲染: <div class="conversation"> {messages.map(renderMessage)} </div>

// ApprovalDialog.tsx — 审批弹窗
// Props: { request: ApprovalRequest | null, onApprove: (id) => void, onDeny: (id) => void }
// 消费: GUARD_APPROVAL_REQUEST → 弹窗
// 渲染: {request && <Modal title="Allow {tool}?" ...><button approve> <button deny>}

// VerificationPanel.tsx — 验证结果
// Props: { results: {criterion, passed, message}[], status: string }
// 消费: VERIFICATION_RESULT → 更新
// 渲染: <ul>{results.map(r => <li class={r.passed ? "pass" : "fail"}>{r.criterion}: {r.message}</li>)}</ul>

// DiffView.tsx — diff + undo
// Props: { sessionId, onUndo: () => void }
// 消费: GET /sessions/:id/diff → git diff or journal entries
// 渲染: <pre>{diff}</pre> + <button onClick={onUndo}>Undo</button>

// CostGauge.tsx — 成本仪表
// Props: { spent: number, budget: number | null }
// 消费: COST_UPDATE → 更新
// 渲染: <div>${spent.toFixed(2)} / {budget ? `$${budget}` : "unlimited"}</div>

// StuckWarning.tsx — 卡住警告
// Props: { warning: StuckWarning | null }
// 消费: STUCK_WARNING → 更新
// 渲染: {warning && <div class="warning">⚠ Stuck: {warning.pattern} ({warning.repetitions}x)</div>}

// SettingsPage.tsx — provider/model 配置
// Props: { config: ForgeConfig, onSave: (config) => void }
// 消费: GET/PUT /config
// 渲染: provider 列表 + model 选择 + effort 选择 + 测试连接按钮

// StatusBar.tsx — 底部状态栏
// Props: { status: string, costSpent: number, costBudget: number|null, stuck: boolean }
// 渲染: {status} | ${costSpent} / ${costBudget} | {stuck ? "⚠ Stuck" : ""}
```

### 验收

```
1. 打开 desktop app
2. 选择项目
3. 输入 "create hello.txt" + trust level "high" + criteria file_exists:hello.txt
4. 点击 Create
5. 看到对话流（文字流式 + write 工具调用 + result）
6. 如果 bash 被调 → 审批弹窗 → approve
7. agent 停止 → VerificationPanel 显示 file_exists: pass
8. 点击 Diff → 看到 hello.txt 的 diff
9. 点击 Undo → hello.txt 被删除
```

---

## 8. 构建 + 测试

### 8.1 Tauri sidecar 配置

```json
// desktop/src-tauri/tauri.conf.json
{
  "build": {
    "beforeDevCommand": "cd .. && npm run dev",
    "beforeBuildCommand": "cd .. && npm run build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true
  },
  "bundle": {
    "externalBin": ["forge-server"]
  }
}
```

### 8.2 测试策略

| 测试类型 | 方法 |
|---|---|
| 护栏单元测试 | 直接调 `evaluateToolCall` / `validate` / `StuckDetector.check` |
| Agent loop 集成 | 用 Pi 的 `faux` provider（mock LLM 响应） |
| Guard hook 集成 | 构造 AgentLoopConfig + faux provider → 跑 agentLoop → 验证 hook 被调用 |
| Golden tasks | `scripted-runtime.ts` → mock streamFn → 验证 session 结果 |
| E2E | 启动 server → HTTP API → 验证 SSE 事件 |

### 8.3 调试用 CLI

```typescript
// src/cli/run.ts
import { runAgent } from "../agent-runner.ts";

const goal = process.argv[2] ?? "create hello.txt";
const session = createSession({ goal, workspace: process.cwd(), trustLevel: "low" });
const result = await runAgent({ session, model: await resolveModel(), ... });
console.log(`Done: ${result.status}`);
```

### 验收

```bash
# 单元测试
npx vitest run src/guardrails/stuck-detector.test.ts

# 集成测试
npx vitest run src/agent-runner.test.ts

# CLI
npx tsx src/cli/run.ts "create hello.txt"

# Server
npx tsx src/cli/serve.ts --port 5300

# Desktop
cd desktop && npm run tauri dev

# Benchmark
npm run bench
```

---

## 9. Checklist（按顺序执行）

### Phase 1: 骨架
- [ ] 创建新项目目录
- [ ] 写 package.json + tsconfig.json
- [ ] 安装 Pi 依赖
- [ ] 复制护栏文件（§2.1）
- [ ] 写 src/types.ts（§3.1）
- [ ] 写 src/persistence/session-store.ts（§3.2）
- [ ] 写 src/persistence/schema.ts 迁移（§3.3）
- [ ] 写 src/agent-runner.ts（§4.1）— 只用 convertToLlm，不加 hooks
- [ ] 写 src/events/mapper.ts（§4.2）
- [ ] 写 src/cli/run.ts（§8.3）
- [ ] **验证**：`npx tsx src/cli/run.ts "create hello.txt"` → 文件被创建，事件打印

### Phase 2: 护栏 + API
- [ ] 写 src/guardrails/before-tool-call.ts（§5.1）
- [ ] 写 src/guardrails/after-tool-call.ts（§5.2）
- [ ] 写 src/guardrails/stuck-detector.ts（§5.4）
- [ ] 写 src/guardrails/cost-guard.ts（§5.5）
- [ ] 写 src/guardrails/transform-context.ts（§5.6）
- [ ] 在 agent-runner.ts 里接入 hooks
- [ ] 写 src/server/session-manager.ts（§6.1）
- [ ] 写 src/server/http-server.ts（§6.2）
- [ ] 写 src/cli/serve.ts
- [ ] **验证**：curl 创建 session → SSE 流能看到事件 → Guard 拦截 workspace 外写入

### Phase 3: 完成验证
- [ ] 写 src/guardrails/should-stop-after-turn.ts（§5.3）
- [ ] 在 agent-runner.ts 里接入 shouldStopAfterTurn
- [ ] 写 src/events/event-types.ts（增加护栏事件类型）
- [ ] **验证**：agent 创建文件但没加 export → 验证 fail → steering 注入 → agent 修复 → 验证 pass

### Phase 4: 桌面 UI
- [ ] desktop/package.json 加 zustand
- [ ] 写 useDesktopStore.ts（§7.1）
- [ ] 写 App.tsx + Sidebar.tsx
- [ ] 写 Composer.tsx（trust level 选择器）
- [ ] 写 SessionView.tsx（对话流 + 工具展开）
- [ ] 写 ApprovalDialog.tsx
- [ ] 写 VerificationPanel.tsx
- [ ] 写 DiffView.tsx + CostGauge.tsx + StuckWarning.tsx + StatusBar.tsx
- [ ] 写 SettingsPage.tsx
- [ ] **验证**：完整桌面流程（选项目 → 输入 → 看对话 → 审批 → 验证 → diff → undo）

### Phase 5: 恢复 + 压缩 + Steering
- [ ] 适配 recovery-service.ts
- [ ] 接入 transformContext（token 估算 + 截断）
- [ ] 接入 prepareNextTurn（Pi 压缩）
- [ ] UI: steering 输入框 + 恢复按钮
- [ ] **验证**：kill → resume → 继续；mid-run steer → agent 改方向

### Phase 6: Benchmark
- [ ] 适配 scripted-runtime.ts（Pi streamFn mock）
- [ ] 适配 harness.ts + metrics.ts
- [ ] **验证**：golden tasks 全部跑通
