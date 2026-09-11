# Forge Design Specification

# 1. Project Definition

Forge is a desktop engineering agent.

Forge is not a chatbot.
Forge is not a coding assistant wrapper.
Forge is not a Pi fork.

Forge adds a deterministic guardrail layer on top of Pi's LLM-driven agent loop.

The goal:

Transform:

"AI helps developers write code"

into:

"AI completes engineering objectives under verified supervision"

---

# 2. Core Philosophy

The LLM is the brain. Guardrails are the safety net.

This is not a state machine. This is not "plan ahead, execute, observe, fix."

The agent loop is Pi's `agentLoop`: query LLM → parse tool calls → execute tools → feed results → repeat. The LLM decides what to do, in what order, and when it's done.

Forge's job is to make that loop trustworthy:

- check every tool call for permission
- back up every file before mutation
- verify completion before accepting "done"
- detect when the agent is stuck
- bound the cost
- log everything for audit and recovery

---

# 3. Architecture

```
Desktop (Tauri + React)
    │  HTTP + SSE
Forge Server (Node)
    │
    ├── AgentRunner
    │   │  装配 AgentLoopConfig + 调 Pi agentLoop
    │   │
    │   ├── Pi AgentLoop (LLM 驱动主循环)
    │   │   ├── query LLM (streaming)
    │   │   ├── parse tool calls
    │   │   ├── execute tools (read/write/edit/bash/grep)
    │   │   ├── feed results to context
    │   │   ├── compaction (Pi built-in)
    │   │   └── repeat until done or stopped
    │   │
    │   └── Guardrail Hooks (注入到 AgentLoopConfig)
    │       ├── beforeToolCall → Guard + Journal
    │       ├── afterToolCall → Stuck detection
    │       ├── shouldStopAfterTurn → Cost + Completion verification
    │       ├── transformContext → Token management
    │       └── getSteeringMessages → Mid-run intervention
    │
    └── Infrastructure
        ├── Event log (FIFO JSONL + SSE)
        ├── Session store + schema migration
        ├── Recovery service
        ├── Approval hub (Guard ask → desktop dialog)
        ├── Undo / Diff (git or journal)
        └── Project registry
```

---

# 4. Pi Integration

Pi is imported in-process, not spawned as subprocess.

```
import { agentLoop } from "@earendil-works/pi-agent-core"
import type { AgentLoopConfig, AgentContext, AgentMessage } from "@earendil-works/pi-agent-core"
import { Models } from "@earendil-works/pi-ai"
```

Pi provides:

- `agentLoop(prompts, context, config, signal, streamFn)` → `EventStream<AgentEvent, AgentMessage[]>`
- `AgentLoopConfig` with hooks: `beforeToolCall`, `afterToolCall`, `shouldStopAfterTurn`, `transformContext`, `prepareNextTurn`, `getSteeringMessages`, `convertToLlm`
- `AgentContext`: messages, systemPrompt, tools, model
- `AgentEvent`: agent_start, turn_start, message_start, text_delta, tool_call, tool_result, turn_end, agent_end
- Built-in tools: read, write, edit, bash, grep, find, ls, powershell
- Built-in compaction: branch-summarization
- Multi-provider: OpenAI, Anthropic, Google, Bedrock, Vertex, custom

Forge provides:

- `AgentLoopConfig` assembly with guardrail hooks
- Guard policy + undo journal
- Deterministic verification (7 validators + command policy)
- Stuck detection (4 patterns)
- Cost guard (budget tracking + circuit breaker)
- Event log (FIFO JSONL + SSE streaming)
- Recovery (session state + event log + journal)
- HTTP API (session-centric)
- Desktop UI (conversation + tool calls + verification)

---

# 5. Agent Loop

Pi's `agentLoop` is the only loop.

```
while (hasMoreToolCalls || pendingMessages.length > 0) {
    1. Process steering messages (inject mid-run)
    2. Query LLM (streaming, via streamFn)
    3. Parse assistant response (text + tool calls)
    4. For each tool call:
        a. beforeToolCall hook → Guard check + Journal backup
        b. Execute tool (Pi built-in or custom)
        c. afterToolCall hook → Stuck detection
    5. Feed tool results to context
    6. shouldStopAfterTurn hook → Cost + Completion verification
    7. prepareNextTurn hook → Compaction (if needed)
    8. Continue or stop
}
```

No state machine. No UNDERSTAND/PLAN/EXECUTE/OBSERVE/FIX states.

The LLM reads code, plans, executes, sees results, fixes, and decides completion — all within this single loop.

---

# 6. Guardrail Model

## beforeToolCall

Called before every tool execution, after argument validation.

```
Input: toolName, args, context
Output: { block?: boolean, reason?: string, terminate?: boolean }
```

Checks:
1. Guard policy (classifyCapabilities → evaluateToolCall)
   - read → allow
   - write/edit → allow (journal-backed)
   - bash → check destructive/network/git patterns → ask
   - destructive → deny + terminate
2. Undo journal (if write/edit: backup file)
3. Approval relay (if ask: send to desktop, wait for response)

## afterToolCall

Called after every tool execution, before result is emitted.

```
Input: toolCall, args, result, isError
Output: { content?, details?, isError?, terminate? }
```

Checks:
1. Stuck detection (track tool_call + result pattern)

## shouldStopAfterTurn

Called after each turn completes (LLM response + tool executions).

```
Input: message, toolResults, context, newMessages
Output: boolean (true = stop)
```

Checks (in order):
1. **Error recovery**（透明，参考 Claude Code）:
   - Output truncated (max_tokens) → inject "continue" steering → return false (max 3 retries)
   - Empty response → inject "try again" steering → return false (max 3 retries)
   - API error (if recoverable) → inject error info → return false
2. Cost guard: is budget exhausted? → return true
3. Stuck detection: is the agent repeating? → return true
4. Completion verification (by trust level):
   - low: return false (let model decide)
   - medium: run build/test → pass → true
   - high: run criteria + evaluator → pass → true

### Error withholding pattern (参考 Claude Code)

API/LLM errors are not immediately surfaced to the user. The hook attempts transparent recovery first:
- Recovery succeeds → agent continues as if nothing happened
- Recovery exhausted (3 attempts) → error surfaced

This prevents premature session termination from transient API issues (truncation, empty response, prompt-too-long).

### Cache stability (参考 Claude Code)

`transformContext` hook also considers prompt cache stability:
- Tool array sorted by name (stable cache key)
- System prompt split into segments with different cache scopes (org/global/none)
- Sticky latch: dynamic parameters once set are kept (avoid busting server cache)
- Non-Anthropic providers skip cache strategy (OpenAI API doesn't support prompt caching scope)

If verification fails, inject steering message: "Verification failed: {reason}. Please continue fixing." and return false.

## transformContext

Called before each LLM query, after convertToLlm.

```
Input: messages, signal
Output: messages (possibly truncated)
```

Checks:
1. Token estimation (character-based approximation)
2. If approaching context window: truncate old observations
3. (Future) Auto-compaction via Pi's prepareNextTurn

---

# 7. Completion Model

Completion is not trusted.

The LLM saying "I finished" does not trigger completion.

Completion is verified based on trust level:

## Low trust (chat, questions)

Model stops → done. No verification.

Used for: explaining code, answering questions, generating snippets.

## Medium trust (routine engineering)

Model stops → run project checks (npm test / npm run build) → pass → done.

If checks fail → tell the model → continue.

Used for: creating files, adding functions, routine bug fixes.

## High trust (safety-critical, autonomous)

Model stops → run all configured success criteria + evaluator → pass → done.

Criteria examples:
```
file_exists: src/auth/controller.ts
command_exit_zero: npm test
file_contains: src/auth/controller.ts → "export"
```

If any criterion fails → tell the model → continue.

Used for: unattended tasks, migrations, security-sensitive changes.

---

# 8. Verification System

Seven deterministic validators:

| Validator | Checks |
|---|---|
| file_exists | fs.access |
| file_contains | readFile + String.includes |
| file_not_contains | readFile + !String.includes |
| directory_exists | fs.stat + isDirectory |
| command_exit_zero | spawn bash, check exit 0, 30s timeout |
| test_pass | command_exit_zero, 120s timeout |
| git_diff_contains | git diff + String.includes |

Command policy (verification commands are restricted):

- Registered checks: npm/pnpm/yarn/bun test|lint|typecheck|build, npx tsc --noEmit, node --test
- Read-only commands: cat, ls, head, tail, wc, stat, file, grep, diff, du, test
- Anything else: blocked (no approval channel for verification)

Path enforcement:
- Absolute paths rejected
- Path escapes (../) rejected
- All paths resolved within workspace

---

# 9. Guard System

Capability model (8 categories):

| Capability | Default | Notes |
|---|---|---|
| read | allow | ls, grep, find, read |
| write | allow | journal-backed (restorable) |
| edit | allow | journal-backed (restorable) |
| bash | ask | approval relay to desktop |
| network | ask | curl, wget, ssh |
| git | ask | all git commands |
| destructive | deny + terminate | sudo, mkfs, rm -rf /, fork bomb, git push --force |
| unknown | ask | unrecognized tools |

Rules:
- First match wins (specific `contains` rules before generic)
- "Always allow" writes a rule to ~/.forge/guard.json
- Policy file re-read on every call (live rule updates)

Undo journal:
- Before every write/edit: copy original file to ~/.forge/undo/{sessionId}/files/
- Journal entry: path, backup path, action (modified/created), timestamp
- Undo: restore backups (or delete created files)

---

# 10. Event System

Events flow from Pi's agent loop to the event log and SSE stream.

```
Pi AgentEvent → Forge agent-runner → event-log.ts (JSONL) → SSE → Desktop
```

Event types:
- SESSION_STARTED, SESSION_ENDED
- TURN_STARTED, TURN_ENDED
- TEXT_DELTA (streaming text)
- TOOL_CALL, TOOL_RESULT
- AGENT_EVENT (raw Pi events for conversation view)

Event log:
- Per-session JSONL file: ~/.forge/events/{sessionId}.events.jsonl
- FIFO append queue (per-session Promise chain, prevents write reordering)
- Read for SSE replay (seq-based, stable across reconnects)

---

# 11. Recovery System

A crashed session is resumable.

State persisted:
- session.json: messages, model, workspace, cost, status
- {sessionId}.events.jsonl: full event history
- undo/{sessionId}/journal.jsonl: file backup entries

Recovery flow:
1. Load session.json → get messages, workspace, model
2. Read events.jsonl → reconstruct state
3. Check undo journal → optional restore
4. Resume: call `agentLoopContinue(context, config, signal, streamFn)`

---

# 12. Data Model

## Session

```
id: string
kind: "conversation" | "task"
goal: string
workspace: string
model: { provider, modelId }
messages: AgentMessage[]   ← Pi's message type, full conversation history
status: "running" | "completed" | "failed" | "cancelled"
failureReason: string | null
cost: { total: number }
completionCriteria: SuccessCriterion[]  ← optional, for high-trust tasks
lastEvaluation: EvaluationResult | null
createdAt: number
updatedAt: number
```

No TaskSession. No Plan. No PlanStep. No Observation.
The conversation IS the task. Messages contain everything.

---

# 13. Desktop UI

UI is the only entry point for human-computer interaction.

Users never touch CLI, API, or event log. Everything flows through the desktop UI.

UI determines what Forge can do. A guardrail capability without a UI entry point does not exist for the user.

Shows:
- Conversation (user messages, assistant text, tool calls, tool results)
- Verification panel (criteria, pass/fail, evidence)
- Diff view (git or journal) + undo button
- Approval dialog (real-time, when Guard asks)
- Cost gauge (spent / budget / remaining)
- Stuck warning (pattern type + suggestion)
- Session list + status bar
- Project selector + settings (provider/model/effort)
- Composer with trust level selector (low/medium/high)
- Mid-run steering input box
- Stop + Resume buttons

Does not show:
- Plan steps (no plan)
- State machine transitions (no state machine)
- Fix attempts (no FIX state)

### Design constraint

Guardrails and UI are designed together. Every guardrail hook's output must have a corresponding UI component that can consume it.

Event types must cover everything the UI needs: agent events (message_start/update/end, tool_call, tool_result) AND guardrail events (GUARD_APPROVAL_REQUEST, VERIFICATION_RESULT, USAGE_UPDATE, STUCK_WARNING, COMPACTION).

HTTP API exists to serve the UI — not the other way around.

---

# 14. Development Rules

Rule 1: LLM is the brain. Guardrails are callbacks, not a loop.

Rule 2: Don't trust "done." Verify by trust level.

Rule 3: Every tool call is checked. Every file mutation is journaled.

Rule 4: Log everything. Events are the source of truth.

Rule 5: Don't duplicate Pi. Use what Pi provides.

---

# 15. First Milestone

User: "Create a TypeScript utility module with tests"

Forge:
1. AgentRunner assembles AgentLoopConfig with guardrail hooks
2. agentLoop starts: LLM reads workspace, creates util.ts, creates util.test.ts
3. beforeToolCall: Guard allows write (journal backups)
4. LLM runs `npm test`
5. beforeToolCall: Guard allows bash (registered check)
6. shouldStopAfterTurn: verify (test_pass: npm test → exit 0 → pass)
7. Session done (verified)
