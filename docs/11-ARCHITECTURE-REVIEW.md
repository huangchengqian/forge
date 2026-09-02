# Forge v1 Autonomous Core — Productization Architecture Review

> Status: Architecture freeze document for Phase 7 planning
> Date: 2026-08-23
> Basis: full source audit of `/Users/hcq/forge/src` (62 files, 4,942 LOC) and `ui/src` (11 files, 943 LOC), plus Pi clone at `pi/` (unmodified upstream)
> Scope: architecture documentation only. No code, no architecture change.

---

# 1. Current Complete Architecture

## 1.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ PRESENTATION                                                         │
│                                                                      │
│  CLI (src/cli)                    UI (ui/, React+Vite, SSE client)   │
│  run.ts — forge run / resume      TaskHeader / PlanView / Timeline   │
│  8 demo scripts                   VerificationPanel / MemoryPanel    │
│         │                              ▲                             │
│         │ injects deps                 │ SSE /snapshot /events       │
└─────────┼──────────────────────────────┼─────────────────────────────┘
          ▼                              │
┌─────────────────────────────────────────────────────────────────────┐
│ ORCHESTRATION LAYER (the brain — owns "what happens next")           │
│                                                                      │
│  engine.ts        state machine tick loop (10 states)                │
│  scheduler.ts     DAG ready-computation + maxConcurrency=2           │
│  runner.ts        runStepBatch (parallel prompt dispatch)            │
│  planner.ts ────  Planner interface                                  │
│  llm-planner.ts   default planner (LLM JSON plan / skill template)   │
│  plan-ops.ts      add/remove/update/reorder (pure, versioned)        │
│  fix-decision.ts  deterministic FIX strategy (no LLM)                │
│  retry-policy.ts  maxAttemptsPerStep=3, maxFixesPerTask=10           │
│  instruction.ts   PlanStep → runtime prompt                          │
└──────┬──────────────┬───────────────┬──────────────┬────────────────┘
       │              │               │              │
       ▼              ▼               ▼              ▼
┌───────────┐  ┌─────────────┐  ┌───────────┐  ┌──────────────────┐
│ SKILLS    │  │ VERIFICATION│  │EVALUATION │  │ MEMORY           │
│ registry  │  │ validate.ts │  │ Evaluator │  │ store/retriever/ │
│ match by  │  │ 7 criteria  │  │ 4 rules   │  │ extractor        │
│ keywords  │  │ verifyCrit. │  │ score100  │  │ keyword search   │
└───────────┘  └─────────────┘  └───────────┘  └──────────────────┘
       │              │               │              │
       └──────────────┴───────┬───────┴──────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ RUNTIME SEAM (the only boundary Forge Core knows)                    │
│                                                                      │
│  interface.ts:  AgentRuntime { createSession/prompt/abort/destroy }  │
│  implementations:  PiRuntime (subprocess+NDJSON)  FakeRuntime (test) │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PI ADAPTER (src/runtime/pi) — the only code that knows Pi            │
│  pi-process    spawn node dist/rpc-entry.js --mode rpc --provider..  │
│  pi-rpc-client stdin/stdout JSONL, request-id correlation            │
│  pi-adapter    PiRuntime implements AgentRuntime                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
                    Pi coding-agent process
                    (packages/ai → 30+ providers)
                               ▼
                    LLM Provider API (minimax/anthropic/openai/…)

CROSS-CUTTING:
  events/    EventBus (in-proc pub/sub) + ForgeEvent union (14 types)
  recovery/  TaskRecoveryService.inspect/.plan (load-from-disk decisions)
  core/      types + state machine + persistence (task JSON, event JSONL)
```

## 1.2 Module Inventory (audited)

| Module | Path | Files | LOC | Responsibility |
|---|---|---|---|---|
| core | `src/core` | 9 | 290 | Types, state machine, persistence primitives |
| orchestrator | `src/orchestrator` | 11 | 1,119 | Lifecycle engine, planner, scheduler, fix, retry |
| runtime | `src/runtime` | 9 | 646 | AgentRuntime seam, Pi adapter, Fake, UI server |
| verification | `src/verification` | 4 | 419 | 7 deterministic criteria validators |
| evaluation | `src/evaluation` | 3 | 162 | Deterministic quality evaluator |
| memory | `src/memory` | 5 | 297 | Structured engineering knowledge |
| events | `src/events` | 4 | 110 | In-process event bus |
| recovery | `src/recovery` | 3 | 212 | Crash inspection + resume planning |
| skills | `src/skills` | 5 | 239 | Capability templates + keyword matcher |
| cli | `src/cli` | 9 | 1,448 | Entry point + 8 demo scripts |
| ui | `ui/src` | 11 | 943 | React dashboard (SSE projection) |
| **Total** | | **73** | **5,885** | |

## 1.3 State Machine (frozen for v1)

```
READY → UNDERSTAND → PLAN → EXECUTE → OBSERVE ─┬→ EVALUATE ─┬→ COMPLETE (terminal)
                       ▲            │           │            └→ REVIEW_REQUIRED (terminal)
                       │            │           ├→ FIX ──→ EXECUTE
                       └── EXECUTE ◄┘           └→ EXECUTE (multi-step DAG)
any non-terminal → FAILED
terminals: COMPLETE, REVIEW_REQUIRED, FAILED
```

---

# 2. Core Interface Inventory

## 2.1 Stable interfaces (freeze candidates)

These three are the architectural seams. They have multiple implementations or clear substitution intent, and survived every phase without semantic break.

| Interface | Location | Implementations | Stability rationale |
|---|---|---|---|
| `AgentRuntime` | `runtime/interface.ts` | `PiRuntime`, `FakeRuntime` | Proven by seam-test: Orchestrator completes a task with zero Pi. Replacement of Pi is a compile-time exercise. |
| `Planner` | `orchestrator/planner.ts` | `LlmPlanner`, custom (dynplan-demo DynamicPlanner) | createPlan/updatePlan split proven; skill-template path and dynamic-revision path both shipped. |
| `Evaluator` | `evaluation/evaluator.ts` | `DeterministicEvaluator` (LLM evaluator planned, not built) | Single implementation today but the seam exists specifically to admit an LLM-based evaluator later without touching the engine. |

Supporting stable surfaces (classes consumed through narrow call sites):

- `EventBus.subscribe/publish` — in-proc only; semantics will widen (persistence/replay) but signature holds.
- `SkillRegistry.register/get/list/match` — in-memory map; marketplace would add discovery, not change these.
- `verifyCriteria(stepId, criteria, cwd)` — pure function; adding criteria kinds does not change it.
- `TaskRecoveryService.inspect/plan` — decision objects are additive.

## 2.2 Interfaces likely to change (Phase 7 pressure points)

| Surface | Current shape | Expected change | Driver |
|---|---|---|---|
| `TurnResult` | `{success, text, error}` | Add structured tool calls, usage/cost, streaming handle | Benchmark needs token accounting; UI needs live deltas beyond text_delta passthrough |
| `OrchestratorOptions` | 10 optional fields, constructed ad-hoc in CLI | Config object with validation; per-state model routing | Model-config doc (docs/10) already specifies perState selection as Phase 2 target |
| `ForgeEvent` union | 14 inline literal types | Versioned envelope (`{id, taskId, seq, payload}`) with replay support | Long-running server (7.1) requires event persistence + late-join replay |
| `EvaluationInput.memory` | Passed but unused by rules | Rules consume cross-task failure history | Evaluation accuracy workstream |
| `TaskSession.piSessionId` | Legacy name leaking "Pi" | Rename to `runtimeSessionId` + JSON migration | AGENTS.md §4.2 violation acknowledged since 5.1; blocked on storage migration story |
| `fix-decision.decideFix` | Regex matches literal `"wrong-content"` | Generalize via Planner.updatePlan on FAIL path | D1 limitation from 6.1 |
| `RetryPolicy` | Hardcoded constants, not injectable end-to-end | Per-task/per-project policy file | G-threshold hardcoding (E3) |

---

# 3. Data Model Overview

All persisted as JSON (atomic tmp+rename); event logs as append-only JSONL. No database.

```
TaskSession (source of truth, ~/.forge/tasks/<id>.json)
├── id: string                        "task_YYYYMMDD_xxxxx"
├── goal: string                      immutable after start
├── state: TaskState                  one of 10 states
├── plan: Plan | null
│    ├── id, version (monotonic), objective, createdAt, updatedAt
│    └── steps: PlanStep[]
│         ├── id, intent, status(pending|ready|running|verified|failed|cancelled)
│         ├── attempts: number
│         ├── successCriteria: SuccessCriterion[]   ← Verification contract
│         ├── dependencies: string[]                 ← DAG edges
│         └── executionGroup: string | undefined     ← concurrency grouping
├── currentStepId: string | null      scheduler hint for recovery
├── observations: Observation[]       APPEND-ONLY
│    └── id, stepId, result(PASS|FAIL), attempt,
│        criterionResults[] {criterion, passed, message, exitCode?, output?, metadata?},
│        failureReason?, timestamp
├── runtime: RuntimeSessionInfo|null  {id, directory, createdAt, provider, modelId}
├── piSessionId: string|null          ⚠ legacy name, opaque runtime id
├── directory: string                 workspace root for this task
├── model: {provider, modelId}
├── fixCount: number                  capped at 10 by retry-policy
├── lastEvaluation: EvaluationResult|null
│    └── taskId, score(0-100), status(PASS|WARNING|REVIEW_REQUIRED),
│        findings[{rule,severity,message}], evidence[{kind,detail}]
├── createdAt/updatedAt, failureReason
```

Side stores:

| Store | Path | Shape | Owner |
|---|---|---|---|
| Event log | `~/.forge/events/<id>.events.jsonl` | `{id,type,taskId,at,payload}` × 13 types | engine (append-only) |
| Memory | `~/.forge/memory.json` | `MemoryItem{id,type(PROJECT_FACT\|DECISION\|FAILURE_PATTERN\|SOLUTION),content,source,confidence,keywords,taskRefs}` | memory module |
| UI snapshot | HTTP `/snapshot` | `{task, memory}` projection | ui-server (read-only) |

Model invariants worth freezing:

1. Observations are never mutated or deleted (evidence chain).
2. Plan version increments on every mutation via `applyPlanOps` (pure functions only).
3. Completion requires: all steps verified AND evaluation ∈ {PASS, WARNING}. The agent can never self-declare COMPLETE.
4. Recovery recomputes schedulable steps from plan status; persisted `currentStepId` is a hint, never trusted alone.

---

# 4. Runtime Boundary

## 4.1 Responsibility matrix

| Concern | Forge Core | Pi Runtime | Provider |
|---|---|---|---|
| Task lifecycle (10 states) | ✅ owns | ✗ | ✗ |
| Planning / replanning | ✅ owns | ✗ | ✗ |
| Scheduling & concurrency limit | ✅ owns (scheduler, maxConcurrency) | ✗ | ✗ |
| Verification (criteria pass/fail) | ✅ owns (deterministic) | ✗ | ✗ |
| Evaluation (quality scoring) | ✅ owns (deterministic) | ✗ | ✗ |
| Completion decision | ✅ sole authority | ✗ forbidden | ✗ |
| Retry/FIX policy | ✅ owns | ✗ | ✗ |
| Persistence & recovery | ✅ owns | session files (opaque) | ✗ |
| LLM invocation | ✗ | ✅ owns (pi-ai, 30+ providers) | ✅ serves |
| Tool execution (read/bash/edit/write) | ✗ | ✅ owns | ✗ |
| Session transcript storage | ✗ reference only | ✅ owns (~/.pi sessions) | ✗ |
| Auth & key management | env passthrough only | ✅ resolves (auth.json/env) | ✅ validates |

## 4.2 Boundary mechanics (as built)

- Transport: subprocess `node pi/packages/coding-agent/dist/rpc-entry.js --mode rpc --provider P --model M`, cwd = task dir; NDJSON on stdio; request-id correlation.
- Isolation: one Pi process per task; cwd confinement; keys injected via env at spawn, never persisted/logged by Forge.
- Failure containment: Pi crash → `exit` handler rejects pending prompts → task FAILED (or recoverable via 5.3 service). Pi cannot corrupt Forge state across the process boundary.
- Replaceability evidence: `seam-test.ts` drives a full lifecycle to COMPLETE with `FakeRuntime` — zero Pi involvement. Swapping runtimes = new class implementing 4 methods.

## 4.3 Known leaks / debts at the boundary

1. `TaskSession.piSessionId` field name (semantic leak; value already opaque).
2. `TurnResult.text` flattens away tool-call structure — fine for v1 criteria, insufficient for rich audit/benchmark.
3. One shared runtime session per task even when steps run concurrently (G1): true parallelism bounded by Pi's per-session serialization.
4. `--cwd` documented in docs/09 was wrong; actual mechanism is Node `spawn(..., {cwd})`. Doc correction pending (noted since Step 1).

---

# 5. Next-Phase Roadmap

## Phase 7.1 — Long Running Server

Goal: transform `forge run` from one-shot CLI into a durable service; close U1/U2/P3 limitations.

Scope:
- `forge serve`: long-lived HTTP+SSE host owning the EventBus; tasks submitted via POST, observed via SSE with historical replay (persisted event log already exists — wire it).
- Event envelope versioning (`seq`, replay cursor) on top of existing JSONL.
- Process supervision: Pi child lifecycle decoupled from CLI exit; watchdog restart using TaskRecoveryService.
- Config surface from docs/09 §10 deferred items: catalog cache, per-state models.
- Multi-task dashboard enablement (UI already consumes events; needs task list endpoint).

Exit criteria: submit task over HTTP, kill the server mid-EXECUTE, restart, observe completion via re-attached SSE stream with full timeline replay.

## Phase 7.2 — Benchmark

Goal: measure what "autonomous core" actually delivers; make regressions visible.

Scope:
- Harness on `FakeRuntime` first (deterministic, free): replay N scripted tasks through the real engine, assert state trajectories + observation counts + wall time.
- Extend `TurnResult` with usage/cost so real-Pi runs report tokens per task/state.
- Golden-task suite: hello-file, multi-criteria verify, DAG parallel, crash-resume, retry-warning — promote the 8 demos into assertions.
- Scorecard: success rate, mean attempts, fix-budget consumption, evaluation-score distribution.
- CI gate: typecheck + 27 unit tests + seam-test + golden suite.

Exit criteria: one command produces a stable JSON scorecard comparing two engine builds.

## Phase 7.3 — Human Collaboration

Goal: make REVIEW_REQUIRED actionable and intervention safe.

Scope:
- `REVIEW_REQUIRED` lifecycle: review queue endpoint, approve/reject/annotate transitions (new states or sub-states — design first, this touches the frozen state machine).
- Pause/resume + steering injection (Pi RPC already supports steer/follow_up; expose deliberately).
- Approval gates before destructive steps (extend SuccessCriterion or step flags).
- Fix-path upgrade: route OBSERVE-FAIL through `Planner.updatePlan` (closes D1/G3) before burning retry budget.
- Policy injection: thresholds currently hardcoded (retry limits, evaluation penalties) move to config.

Exit criteria: a task that ends REVIEW_REQUIRED can be approved back to life by an operator command, resuming from persisted state with zero re-execution of verified steps.

Sequencing note: 7.1 first (server is prerequisite for remote approval UX), 7.2 can proceed in parallel (FakeRuntime-only), 7.3 depends on both.

---

# 6. Risk Register

| # | Risk | Category | Severity | Evidence | Mitigation direction |
|---|---|---|---|---|---|
| R1 | **Complexity growth in engine.ts** — single file now owns 6 states, batch runner wiring, planner hooks, evaluation hook, event emission; 606 lines and every phase added a case | complexity | High | engine.ts grew monotonically each phase; transitions table + switch + helpers interleaved | Extract per-state transition handlers (files already named in docs/08 §4 but never split); freeze state count until 7.3 design |
| R2 | **Dual-write inconsistency** — `saveTask` then `appendEvent` are two separate writes; crash between them loses the event but keeps the snapshot | state consistency | Medium | Documented as accepted P6; snapshot is declared source of truth | Accept for v1 (snapshot wins); 7.1 event envelope should record `stateAfter` so replay can self-heal |
| R3 | **Concurrent steps share one runtime session** — parallelism is structural, not physical; a slow/hung Pi turn blocks the whole batch; batch failure policy sends all-or-nothing to FIX | scalability | High | G1/G3; PiRpcClient has deadline but batch has partial-failure asymmetry | Session pool (one Pi process per concurrent slot); per-step result handling in OBSERVE instead of all-passed gate |
| R4 | **Recovery trusts snapshot completeness** — currentStepId is written only inside runStepBatch; crash between PLAN transition and first batch leaves hint null (fallback scan covers it, but ordering assumptions grow with every new write site) | recovery | Medium | P4; recovery tests cover inspect/plan but not mid-batch kill of a *real* process | 7.1 watchdog must include chaos test: SIGKILL during runStepBatch, assert post-resume trajectory |
| R5 | **Evaluation accuracy is structural, not semantic** — 4 rules catch process smell (retries, missing criteria, giant diffs) but cannot judge correctness of code; WARNING threshold hardcoded | evaluation accuracy | Medium-High | E1–E4; Scenario B passes with warnings despite fabricated failures | Keep DeterministicEvaluator as floor; add pluggable LLM evaluator behind existing `Evaluator` seam in 7.2 benchmark context where cost is measurable |
| R6 | **Memory retrieval is lexical** — keyword overlap only; same-concept different-token misses silently degrade UNDERSTAND prompts | quality drift | Low-Medium | L1 from Phase 3; confidence never decays (L4) | Not a 7.x blocker; revisit only if golden suite shows recall gaps |
| R7 | **Skill template variable extraction is regex guessing** — wrong path guesses produce plans that fail expensively through FIX cycles | complexity | Medium | S1/S7; skill-demo needed a FIX round-trip to discover the filename | Require explicit path in goal or skill params; fail fast in PLAN state when `{{path}}` renders to fallback heuristic |
| R8 | **No cycle detection in DAG** — A→B→A yields "no executable step but pending remains" → FAILED, discovered only at runtime | state consistency | Medium | G6; scheduler has no visited-set | Cheap validation in `applyPlanOps`/createPlan: reject cycles at plan-write time |
| R9 | **Docs drift** — docs/09 documents `--cwd` flag that doesn't exist; several phase reports corrected themselves post-hoc | complexity | Low | Step-1 limitation #8; lockfile side-effect noted | 7.0 exit includes doc sweep against audited behavior |
| R10 | **Key handling surface grows with providers** — env passthrough today; OAuth flows exist in Pi but Forge bypasses them | security | Low-Medium | pickProviderEnv covers 6 providers by name | Keep Forge out of the auth business permanently; delegate to Pi credential store when needed |

Top-3 for immediate attention in Phase 7 planning: **R1** (engine decomposition before adding 7.3 states), **R3** (session pool before claiming real parallelism), **R5** (evaluation credibility before benchmark publishes numbers).

---

# 7. Freeze Statement

Effective immediately for all Phase 7.x work:

1. The 10-state machine, `AgentRuntime`, `Planner`, `Evaluator` signatures are frozen. Changes require a written amendment to this document.
2. New capabilities must enter through existing seams (new `Evaluator`/`Planner`/`AgentRuntime` implementations, new criteria kinds, new skill entries) — not through engine.ts special cases.
3. Storage stays JSON/JSONL until 7.1 ships replay; any migration (e.g., `piSessionId` rename) must ship with a reader-side default, not a rewrite script.
4. Pi remains an unmodified upstream dependency pinned to the local clone; adapter-only evolution.
