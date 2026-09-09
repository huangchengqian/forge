# Forge Agent Development Rules

## 1. Purpose

This document defines the development rules for AI coding agents working on Forge.

The purpose is to prevent architectural drift during development.

Every implementation decision must respect these rules.

---

## 2. Project Identity

Forge is not:

- a chatbot
- a coding assistant wrapper
- a Pi fork

Forge is:

A desktop engineering agent that uses LLM as brain and deterministic guardrails as safety net.

The core value of Forge is:

- completion verification (don't trust "model says done")
- guardrails (permission, undo journal, cost budget, stuck detection)
- recovery (event log, crash resume, audit trail)

---

## 3. Architecture Principle

Two layers, clean boundary.

## Agent Layer (Forge)

Responsible for:

- assembling Pi AgentLoopConfig with guardrail hooks
- guardrails: permission, verification, cost, stuck detection
- event log + SSE streaming
- crash recovery
- HTTP API + desktop UI

## Runtime Layer (Pi)

Responsible for:

- LLM communication (multi-provider streaming)
- agent loop (query → tool calls → results → repeat)
- tool execution (read/write/edit/bash/grep)
- context compaction
- extension system

The boundary:

```
Forge (guardrails) → AgentLoopConfig hooks → Pi (agent loop)
```

Forge injects guardrails as callbacks. Pi owns the loop. One loop, not two.

## Monolith Principle

Forge is a big monolith. In-process module boundaries are NOT protocol boundaries.

- The compiler is the contract. No versioning, no migration, no deprecation windows for in-process types.
- The only two real boundaries: desktop ↔ server (HTTP/SSE — a Tauri process-model detail, not a service boundary) and code ↔ disk (JSONL / session files — forward-only compatibility discipline applies here, and only here).
- In-process event distribution uses the observer pattern (EventBus), justified by "publishers must not import subscriber modules" — not by "protocol independence".

---

## 4. Integration Rules

Pi is imported in-process as npm packages.

- `@earendil-works/pi-agent-core` — agent loop + types
- `@earendil-works/pi-ai` — multi-provider LLM API
- `@earendil-works/pi-coding-agent` — tools + extensions

### Rule 4.1

Forge guardrails are Pi AgentLoopConfig callbacks, not an outer loop.

Bad: Forge runs its own `while not done` loop around Pi.

Good: Forge assembles `AgentLoopConfig` with `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` and calls `agentLoop()`.

### Rule 4.2

Forge does not duplicate Pi capabilities.

Pi already has: agent loop, tools, compaction, multi-provider, streaming, extensions.

Forge adds: guardrails, verification, event log, recovery, UI.

If Pi has it, use it. Don't rebuild.

### Rule 4.3

Forge core does not import Pi internals beyond the published package API.

Allowed:

```
import { agentLoop } from "@earendil-works/pi-agent-core"
import type { AgentLoopConfig, AgentContext } from "@earendil-works/pi-agent-core"
```

Forbidden:

```
import { someInternalFunction } from "@earendil-works/pi-agent-core/src/internals"
```

---

## 5. Guardrail Rules

### Rule 5.1

Completion is not trusted.

The LLM saying "I'm done" does not mean done.

Completion requires verification, configured by trust level:

- low: model stops → done (chat/questions)
- medium: model stops → run build/test → pass → done
- high: model stops → run all criteria + evaluator → pass → done

This is enforced in `shouldStopAfterTurn` hook.

### Rule 5.2

Every tool call is checked before execution.

`beforeToolCall` hook:
1. Guard policy (capability classification + rule evaluation)
2. Undo journal (backup file before write/edit)
3. Approval relay (ask → desktop dialog)

A denied tool call is blocked. A destructive tool call terminates the session.

### Rule 5.3

Stuck detection prevents infinite loops.

`afterToolCall` + `shouldStopAfterTurn` hooks detect:
- repeated action-observation pairs (4 times)
- repeated action-error pairs (4 times)
- agent monologue without tool calls (4 times)
- alternating pattern A→B→A→B (6 times)

### Rule 5.4

Cost is bounded.

`shouldStopAfterTurn` checks cost budget. When exhausted, session stops.

### Rule 5.5

Errors are recovered transparently (参考 Claude Code).

`shouldStopAfterTurn` attempts recovery before surfacing errors:
- Output truncated → inject "continue" steering → retry (max 3)
- Empty response → inject "try again" steering → retry (max 3)
- API error → inject error info → retry (max 3)
- Recovery exhausted → error surfaced to user

This is the error withholding pattern: recovery succeeds = user never sees the error.

### Rule 5.6

Cache stability is maintained (参考 Claude Code).

`transformContext` considers prompt cache:
- Tool array sorted by name (stable cache key)
- System prompt split into cache segments (org/global/none scope)
- Sticky latch: dynamic params once set are kept
- Non-Anthropic providers skip cache strategy

---

## 6. Verification Rules

### Rule 6.1

Verification is deterministic.

Bad: "The model thinks the code is correct."

Good:

```
file_exists
file_contains
command_exit_zero
test_pass
git_diff_contains
directory_exists
file_not_contains
```

### Rule 6.2

Verification commands are restricted.

Only these run automatically:
- project runners: npm/pnpm/yarn/bun test|lint|typecheck|build
- type checker: npx tsc --noEmit
- test runner: node --test
- read-only: cat, ls, head, tail, wc, stat, file, grep, diff, du, test

Anything else requires an explicit Guard allow rule.

### Rule 6.3

Every verification produces evidence.

```
What was checked?
How was it checked?
What was the result?
```

---

## 7. Event Rules

### Rule 7.1

All agent events are logged.

Pi's event stream is consumed and written to a per-session JSONL event log.

The log is the source of truth for:
- SSE streaming (replay + tail follow)
- crash recovery
- audit trail

### Rule 7.2

Event log writes are FIFO-ordered.

Concurrent `appendFile` calls race in the libuv threadpool. Per-session Promise chain ensures call-order persistence.

### Rule 7.3

The EventBus is a fan-out of the event log, not a second source of truth.

`appendEvent` writes to the JSONL log, then fans out control-plane events (`isControlEvent`) to the in-process `defaultBus`. Data-plane events (TURN / MESSAGE / TEXT_DELTA / TOOL families) stay in the log only — in-process listeners must not be flooded by per-turn data volume.

SSE and the desktop read the log, never the bus. Subscriber count today is zero: when a feature needs the bus, subscribe in the module that needs it — no new machinery, no protocol layers.

---

## 8. Recovery Rules

### Rule 8.1

Sessions are recoverable.

A crashed session can be resumed because:
- session state is persisted (session.json)
- event log has the full history (events.jsonl)
- undo journal has file backups (journal.jsonl)

### Rule 8.2

Schema migrations are forward-only.

When the data model changes, `schema.ts` adds a migration. Old sessions are migrated on load.

---

## 9. UI Rules

### Rule 9.1

UI is the only entry point.

Users never touch CLI, API, or event log. Everything flows through the desktop UI.

UI determines what Forge can do. A guardrail capability without a UI entry point does not exist for the user.

### Rule 9.2

Every guardrail must have a UI entry point.

| Guardrail | UI component |
|---|---|
| Guard ask (approval) | ApprovalDialog (real-time popup) |
| Completion verification | VerificationPanel (criteria + pass/fail + evidence) |
| Undo journal | DiffView + undo button |
| Cost budget | CostGauge (spent / budget) |
| Stuck detection | StuckWarning (pattern + suggestion) |
| Steering | Mid-run input box |
| Streaming | SessionView (real-time conversation) |
| Session management | SessionList + StatusBar |
| Project/workspace | Sidebar + project selector |
| Model config | SettingsPage |
| Trust level | Composer (low/medium/high selector) |
| Abort/resume | Stop button + Resume button |

### Rule 9.3

Guardrails and UI are designed together.

Build order:
1. Agent runner (Pi loop + hooks)
2. Guardrails + event types + HTTP API (同期 — 护栏产出事件，API 传输事件，UI 消费事件)
3. Completion verification + stuck detection
4. Desktop UI (consume event stream + collect user input)
5. Recovery + compaction + steering
6. Benchmark

---

## 10. Development Process

Before implementing any feature, answer:

1. What problem does this solve?
2. Is this a guardrail or a Pi capability?
3. Which AgentLoopConfig hook does it plug into?
4. What is the input?
5. What is the output?
6. What events are produced?
7. How is it tested?

---

## 11. Code Organization

Prefer:

- small modules
- clear ownership
- explicit interfaces
- guardrails as pure functions

Avoid:

- large services
- state in guardrails (state lives in Pi context + event log)
- cross-layer dependencies
- duplicating Pi functionality

---

## 12. Change Rules

Do not:

- rewrite unrelated modules
- introduce unnecessary frameworks
- change architecture without discussion

Prefer:

- minimal changes
- incremental commits
- preserving boundaries

## Branch discipline

`main` is always releasable.

Work on a short-lived branch (`feat/...`, `fix/...`) when the change crosses layers or touches the hook contract.

Small, obviously-green changes go directly to `main`.

---

## 13. First Development Goal

Prove: Pi agentLoop + Forge guardrails can complete a verified engineering task.

Required flow:

```
User goal
    ↓
agentLoop(prompt, context, config with hooks)
    ↓
LLM queries, calls tools, gets results
    ↓
shouldStopAfterTurn → verify completion
    ↓
Session done (verified)
```

No UI. No memory. No multi-agent.

Only prove the loop works and guardrails fire.

---

## 14. Final Principle

The intelligence comes from the LLM.

The trustworthiness comes from guardrails.

Do not build a state machine to replace LLM judgment.
Do not trust LLM judgment without guardrails.
