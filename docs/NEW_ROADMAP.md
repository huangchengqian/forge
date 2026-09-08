# Forge Development Roadmap

# 1. Development Philosophy

UI is the only entry point. Users never touch CLI, API, or event log.

This means:
- Every guardrail capability must have a UI entry point
- Guardrails and UI are designed together, not sequentially
- Event types must cover everything the UI needs to display
- HTTP API exists to serve the UI, not the other way around

Build order:

```
Agent loop (Pi integration)
    ↓
Guardrails + Event types + HTTP API (同期)
    ↓
Completion verification + Stuck detection
    ↓
Desktop UI (消费事件流 + 收集用户输入)
    ↓
Recovery + Compaction + Steering
    ↓
Benchmark
```

---

# 2. Phase 1 - Skeleton (1-2 days)

## Goal

Pi agentLoop runs in-process. Events flow to stdout.

## Scope

- Copy Forge code to new project
- Delete state machine + RPC layer (~1700 lines)
- Add `@earendil-works/pi-agent-core` + `pi-ai` dependencies
- Write `agent-runner.ts`: minimal AgentLoopConfig (convertToLlm only)
- Write minimal `Session` type
- CLI `run.ts`: `runAgent(goal) → stream events → print` (debug only)
- No guardrails, no UI, no server

## Expected Result

```
$ npx tsx src/cli/run.ts "create hello.txt"
[agent_start] [turn_start] [message_start] [text_delta: "Creating..."]
[tool_call: write] [tool_result] [turn_end] [agent_end]
hello.txt created.
```

---

# 3. Phase 2 - Guardrails + Events + API (2-3 days)

## Goal

Every tool call is checked. Every file mutation is journaled. Events flow to event log + SSE. Minimal HTTP API serves sessions.

Guardrails produce events. API transports events. UI will consume events (Phase 4). Build all three now.

## Scope

### Guardrail hooks
- `beforeToolCall` → Guard policy (policy.ts) + Journal (journal.ts)
- Event type extensions: GUARD_APPROVAL_REQUEST, GUARD_BLOCKED, COST_UPDATE

### Event flow
- Pi AgentEvent → event-log.ts (FIFO append) → event-bus.ts
- SSE stream → TaskEventStream (replay + tail + seq dedup)

### HTTP API
- `session-manager.ts`: workspace lock, session store, approval hub
- POST /sessions (create), GET /sessions/:id/stream (SSE), POST /sessions/:id/abort, DELETE /sessions/:id
- GET /sessions/:id/approvals, POST /sessions/:id/approvals/:reqId/approve|deny
- GET /sessions/:id/diff, POST /sessions/:id/undo

## Expected Result

```
# POST /sessions {goal: "create hello.txt", workspace: "/tmp/test", trustLevel: "low"}
# GET /sessions/:id/stream → SSE: SESSION_STARTED, TURN_STARTED, TOOL_CALL, TOOL_RESULT, TURN_ENDED, SESSION_ENDED
# write to /etc/passwd → GUARD_BLOCKED event in SSE
# write to workspace/hello.txt → allowed, journaled
# bash with curl → GUARD_APPROVAL_REQUEST event → POST /approve → continue
```

---

# 4. Phase 3 - Completion Verification + Stuck Detection (1-2 days)

## Goal

Don't trust "model says done." Detect stuck agents. Bound cost.

## Scope

- `shouldStopAfterTurn` → error recovery (truncated/empty/error, max 3 retries, transparent) + cost guard + completion verification (by trust level)
- `CompletionConfig`: trust level (low/medium/high) + criteria + maxCost + maxTurns
- `afterToolCall` → stuck detection (4 patterns: action_observation_loop, action_error_loop, monologue, alternating_pattern)
- `evaluation/deterministic-evaluator.ts` → post-completion scoring
- Verification steering: "Verification failed: {reason}. Please continue."
- Error withholding: API errors suppressed until recovery exhausted (参考 Claude Code)
- `transformContext` → token estimation + truncation + cache stability (tool sorting, prompt segment caching)
- Event types: VERIFICATION_RESULT, STUCK_WARNING, ERROR_RECOVERY

## Expected Result

```
# Task: "create util.ts with export"
# Model creates util.ts (no export) → stops
# shouldStopAfterTurn → file_contains: "export " → FAIL
# VERIFICATION_RESULT event: {criterion: "file_contains", passed: false, message: "does not contain 'export'"}
# Steering injected: "Verification failed: file does not contain 'export'. Please continue."
# Model adds export → stops again
# VERIFICATION_RESULT event: {passed: true} → SESSION_ENDED
```

---

# 5. Phase 4 - Desktop UI (3-5 days)

## Goal

User completes a full workflow through the desktop UI. Never touches CLI or API.

UI consumes the event stream (Phase 2) and API (Phase 2-3). Every guardrail capability has a UI entry point.

## Scope

### Layout
- `App.tsx` + `Sidebar.tsx`: project selector + session list
- `Composer.tsx`: input box + trust level selector (low/medium/high) + create session button

### Main view (consumes SSE events)
- `SessionView.tsx`: conversation stream (MESSAGE_STARTED/UPDATE/ENDED + TEXT_DELTA + TOOL_CALL + TOOL_RESULT)
- `ApprovalDialog.tsx`: popup when GUARD_APPROVAL_REQUEST event arrives → POST /approve or /deny
- `VerificationPanel.tsx`: VERIFICATION_RESULT → criteria list + pass/fail + evidence
- `DiffView.tsx`: GET /sessions/:id/diff → git diff or journal entries + undo button → POST /undo
- `CostGauge.tsx`: COST_UPDATE event → spent / budget / remaining
- `StuckWarning.tsx`: STUCK_WARNING event → pattern type + suggestion
- `StatusBar.tsx`: session status + cost + stuck indicator

### Settings
- `SettingsPage.tsx`: provider config + model selection + effort level
- Project management: add/remove/select projects (from old Forge desktop shell)

## Expected Result

Full desktop experience:
1. Select project → input goal → choose trust level → create
2. Watch real-time conversation (text streaming + tool calls expanding)
3. Approval popup appears → approve/deny → agent continues
4. Verification panel shows criteria + pass/fail
5. Review diff → undo if needed
6. Cost gauge shows spending
7. Stuck warning appears if agent loops

---

# 6. Phase 5 - Recovery + Compaction + Steering (2-3 days)

## Goal

Crash recovery. Long conversation support. User can steer mid-run.

## Scope

### Recovery
- `recovery-service.ts` adapted to new Session model
- Session list shows "recoverable" status for crashed sessions
- Resume button → POST /sessions/:id/resume → agentLoopContinue

### Compaction
- `transformContext` hook → token estimation + truncation
- `prepareNextTurn` hook → trigger Pi built-in compaction
- COMPACTION event → UI shows compaction status

### Steering
- `getSteeringMessages` hook → connected to UI mid-run input box
- POST /sessions/:id/steer → inject steering message
- UI: input box visible during execution → type → send → agent picks up at next turn boundary

## Expected Result

```
# Start task, kill process mid-execution
# Session list shows "recoverable"
# Click resume → session resumes from last event, agent continues

# Mid-execution: type "also add a README.md" in steering input
# Agent picks up at next turn boundary, creates README.md too
```

---

# 7. Phase 6 - Benchmark (1-2 days)

## Goal

Golden tasks verify the architecture works end-to-end.

## Scope

- `scripted-runtime.ts` → Pi streamFn mock (deterministic tool responses)
- `harness.ts` → runAgent with scripted runtime
- `metrics.ts` → adapted to new Session model
- Golden tasks: file creation, multi-step, fix-and-verify, stuck-loop

## Expected Result

```
=== golden_create_file [new-feature] Create hello.txt
  -> state=completed wall=120ms retries=0 cost=$0.01 vfail=0 eval=100

=== golden_verify_fail [new-feature] Create util.ts without export
  -> state=completed wall=340ms retries=1 cost=$0.03 vfail=1→0 eval=95

=== golden_stuck_loop [recovery] Repeated failure
  -> state=failed wall=5000ms cost=$0.15 stuck=action_observation_loop eval=20
```

---

# 8. Phase 7 - Memory (future)

## Goal

Semantic memory retrieval across sessions.

Not priority until phases 1-6 are stable.

## Scope

- Memory format: file directory + frontmatter (~/.forge/memory/*.md)
- Memory scan: read frontmatter (description + type + keywords)
- Semantic retrieval: LLM side-query for relevance (like OpenHands findRelevantMemories)
- `transformContext` hook: inject relevant memories before LLM query
- Memory extraction: after session complete/failed, extract patterns
- UI: memory browser in settings

---

# 9. Phase 8 - Advanced (future)

## MCP support
Model Context Protocol servers as tool providers.

## Sub-agents
Pi AgentTool for multi-agent orchestration.

## Workflow engine
Deterministic orchestration for multi-step tasks (concurrency + budget + journal).

## Background tasks
Long-running sessions, scheduled execution.

---

# 10. Current Priority

Build Phase 1: Pi agentLoop runs in-process.

Not priority:
- memory
- multi-agent
- cloud
- workflow engine

---

# 11. Success Criteria

Phase 1 success: `npx tsx src/cli/run.ts "create hello.txt"` → file created, events streamed.

Phase 3 success: Agent creates file without required content, stops, gets "verification failed," fixes it autonomously.

Phase 4 success: Full desktop flow — select project → input goal → watch execution → approve tool call → see verification → review diff → undo.

Phase 5 success: Kill process mid-task → resume → continues. Type mid-run message → agent picks up.

Phase 6 success: Golden tasks all pass with expected metrics.
