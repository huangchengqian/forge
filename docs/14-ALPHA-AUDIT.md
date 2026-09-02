# Forge Alpha Product Audit

> Date: 2026-08-23
> Scope: full codebase audit (src 73f/6,439L + desktop 7f/407L + ui 11f/943L = 91 files, ~7,789 lines)
> Constraint: read-only analysis, no code changes

---

# 1. Alpha User Journey

## 1.1 First Launch

| Step | What happens | Status |
|---|---|---|
| Install | Clone repo → `npm install` → `cargo tauri dev` or `npx tsx src/cli/serve.ts` | ⚠️ No packaged binary; requires Node ≥22 + Rust toolchain |
| Onboarding | None exists | 🔴 No first-run wizard: no provider key setup, no project picker, no intro |
| API key setup | User must manually set env var before launch (`ANTHROPIC_API_KEY` etc.) or task creation fails with exit code 2 and a list of env var names on stderr | 🔴 Desktop has no keychain integration; CLI error message is developer-oriented |
| Project selection | CLI uses `process.cwd()`; Desktop has no project picker dialog | 🔴 Cannot choose which directory to work in from Desktop |

**Verdict**: A new user cannot go from install to first task without reading source code or docs. This is the single largest productization blocker.

## 1.2 First Task Flow

```
User types goal ──► POST /tasks {goal} ──► TaskManager.create()
                                             │
                                             ▼
                                    startTask() — READY state
                                    ensureSession() — spawn Pi subprocess
                                             │
                                             ▼
                              runOrchestrator() tick loop:
                                READY→UNDERSTAND→PLAN→EXECUTE→OBSERVE→EVALUATE→COMPLETE
```

| Step | What works | What's broken/missing |
|---|---|---|
| Goal submission | ✅ POST /tasks returns 202 immediately with taskId | ⚠️ No input validation beyond "goal is non-empty"; no goal-length limit |
| UNDERSTAND | ✅ LlmPlanner sends prompt via runtime, parses JSON plan | 🔴 If LLM returns malformed JSON, falls back to a hardcoded plan referencing hello.txt/wrong-content (Phase 1 artifact) |
| PLAN | ✅ Plan persisted, plan_created event emitted | ⚠️ No user review gate (A-1 amendment pending) |
| EXECUTE | ✅ Scheduler selects ready steps, runner dispatches batch | ✅ Works for single-step and DAG |
| OBSERVE | ✅ verifyCriteria runs deterministic validators | ✅ FIX path triggers on failure |
| EVALUATE | ✅ Deterministic evaluator scores quality | ✅ REVIEW_REQUIRED terminal for critical findings |
| COMPLETE | ✅ Memory extraction, event log, UI notification | ✅ Clean exit |

**Verdict**: The core lifecycle is architecturally sound. The fallback plan is the weakest link — it produces garbage criteria that guarantee FIX-loop exhaustion.

## 1.3 Error Handling Audit

| Error scenario | Current behavior | Adequate? |
|---|---|---|
| Missing API key | CLI: exit(2) with env var list. Server: no check at startup; Pi fails at prompt time | 🔴 Server should pre-flight check at task creation |
| Invalid API key (expired) | Pi subprocess starts, LLM call fails silently, engine falls back to default plan, FIX loop exhausts budget, FAILED after ~10 cycles | 🔴 Should fail fast with clear reason, not burn budget on guaranteed-fail retries |
| Pi subprocess crash | pi-rpc-client detects exit, rejects all pending prompts, runner marks step failed, engine eventually FAILED | ✅ Detected and propagated |
| Server crash mid-task | TaskSession JSON persists; recovery sweep can resume | ✅ Persistence is atomic; events are append-only |
| Deadline exceeded | Engine checks wall-clock each loop iteration; failTask("deadline exceeded") | ✅ But deadline doesn't reset on plan revision (D6) |
| Malformed LLM JSON | tryExtractJson catches parse errors, falls back | ⚠️ Fallback plan is destructive (see above) |
| Network timeout during prompt | Promise.race with deadlineMs; TurnResult.success=false | ✅ |
| Concurrent workspace conflict | Two tasks sharing same directory would conflict; no locking | 🔴 No file-level or advisory locking |

## 1.4 Runtime Crash Recovery

| Aspect | Status |
|---|---|
| TaskSession persistence | ✅ Atomic write (tmp+rename), survives crash |
| Event log persistence | ✅ Append-only JSONL, survives crash |
| Runtime session recreation | ✅ Recovery service detects runtime loss, recreate on resume |
| Boot sweep | ❌ Server does NOT auto-resume interrupted tasks on startup (documented as opt-in flag but not implemented) |
| Zombie process cleanup | ✅ Verified: 0 orphan processes across all test runs |
| Step status consistency | ⚠️ currentStepId only written inside runStepBatch; crash between transition and first batch leaves stale hint (fallback scan covers) |

## 1.5 API Contract Compliance

Verified against docs/13:

| Endpoint | Contract match | Notes |
|---|---|---|
| GET /health | ✅ Open, returns protocolVersion | |
| POST /tasks | ✅ 202 async | |
| GET /tasks | ✅ | |
| GET /tasks/:id | ✅ | |
| GET /tasks/:id/stream | ✅ Protocol v1 envelopes | seq monotonic verified |
| GET /tasks/:id/events | ✅ Legacy, excluded from contract | |
| POST /tasks/:id/cancel | ✅ 202/409 | Cancel semantics = stop signal, not forced terminal |
| POST /tasks/:id/resume | ✅ 202/409 | Uses TaskRecoveryService.inspect |
| POST /projects | ✅ Path validation | |
| GET /projects | ✅ Includes activeProjectId | |
| POST /projects/:id/select | ✅ | |
| GET /memory | ✅ type filter | |
| GET /memory/search | ✅ keyword retrieval | |
| POST /memory | ✅ keywords auto-derived | |

Auth: Bearer token middleware on all routes except /health. Handshake file server.json mode 0600.

## 1.6 Desktop Experience

| Aspect | Status |
|---|---|
| Window management | ✅ Tauri v2 window, resizable, dark theme |
| Sidecar lifecycle | ✅ start/stop via Tauri commands; FORGE_RUNTIME configurable via env |
| Token injection | ⚠️ get_handshake command exists but App.tsx reads window.__FORGE_CONFIG__ which is never populated by Tauri — chicken-and-egg gap |
| Task list view | ❌ Not implemented in desktop/src/App.tsx (only shows selected task detail) |
| Timeline view | ✅ Live SSE stream rendered as numbered events |
| Verification panel | ✅ Observations with PASS/FAIL pills |
| Memory panel | ✅ Read-only list with type/source/confidence |
| Project picker | ❌ Not implemented |
| Settings panel | ❌ Not implemented |

---

# 2. Blockers for Productization

Ranked by impact on "can a real user complete a real task":

| # | Blocker | Category | Impact if unfixed |
|---|---|---|---|
| **B1** | **No onboarding flow**: user cannot configure provider key, select project, or understand what Forge does without reading source | UX | Zero adoptability outside dev team |
| **B2** | **Fallback plan produces guaranteed-fail criteria** ("wrong-content" grep): any LLM JSON parse failure cascades into budget-exhaustion FAILURE instead of graceful retry | Correctness | Any LLM hiccup destroys the task |
| **B3** | **Server doesn't validate API keys at task creation**: invalid key discovered only after 10 wasted FIX cycles (~seconds to minutes of LLM calls) | Cost + UX | Wasted tokens, confusing failure reason |
| **B4** | **Desktop lacks project picker and task list**: user cannot choose working directory or see multiple tasks | UX | Desktop is demo-only, not usable |
| **B5** | **No CI pipeline running tests+benchmark**: regressions undetectable without manual `npm run bench` | Quality | Silent breakage between releases |
| **B6** | **Hardcoded `/Users/hcq/forge/pi` path in pi-paths.ts**: breaks on any other machine | Portability | Build works on exactly one machine |
| **B7** | **No packaged binary**: requires full dev environment (Node 22+, Rust, cargo, Pi clone built locally) | Distribution | Cannot ship to users |

---

# 3. Technical Debt List

| # | Debt | Location | Severity | Description |
|---|---|---|---|---|
| TD1 | `piSessionId` field name leaks Pi concept into Core model | core/types/task-session.ts | 🟡 Low | Rename to `runtimeSessionId`; requires JSON migration |
| TD2 | `fix-decision.ts` regex matches literal `"wrong-content"` | orchestrator/fix-decision.ts:28 | 🟡 Medium | FIX is a no-op for real criteria; needs planner.updatePlan integration |
| TD3 | `checkStepAttempts()` defined but never called in engine | orchestrator/retry-policy.ts | 🟡 Medium | Step retry limit not enforced; only task fixCount caps execution |
| TD4 | Evaluator receives memory but rules don't consume it | evaluation/deterministic-evaluator.ts | 🟢 Low | Interface ready; rules need enhancement |
| TD5 | Event log has no rotation or size cap | core/persistence/event-log.ts | 🟢 Low | JSONL grows unboundedly per task |
| TD6 | UI types are manually synced mirrors (ui/src/shared/types.ts 133L + desktop/src/shared/types.ts 44L) | ui/, desktop/ | 🟡 Medium | Type drift risk; needs codegen from core |
| TD7 | Demo files (10 scripts, ~2000L) mixed with CLI entry points in src/cli/ | src/cli/ | 🟢 Low | Should move to examples/ or tests/ |
| TD8 | engine.ts is 606 lines with all state handlers inline | orchestrator/engine.ts | 🟡 Medium | Growing monolith; per-state extraction recommended |
| TD9 | Hardcoded `/Users/hcq/forge/pi` default path | runtime/pi/pi-paths.ts:4 | 🔴 High | Breaks portability; must use env or discovery |
| TD10 | No file locking for concurrent workspace access | N/A | 🟡 Medium | Two tasks targeting same dir will race |
| TD11 | DAG cycle detection missing (A→B→A causes runtime FAILED) | scheduler/computeReadySteps | 🟡 Medium | Should validate at plan-write time |
| TD12 | `maxConcurrency` has no CLI/API surface | engine.ts | 🟢 Low | Default=2 hardcoded, not user-configurable |

---

# 4. Phase 9 Priority Ranking

## Tier 1 — Must-fix before any external use (Week 1)

| Priority | Item | Addresses | Est. effort |
|---|---|---|---|
| **P9-1** | Remove hardcoded Pi path; use env `PI_REPO_DIR` or auto-discover | B6, TD9 | 30 min |
| **P9-2** | Replace fallback plan with safe no-op (empty steps + warning event); remove "wrong-content" reference | B2, TD2 | 1 hr |
| **P9-3** | Add API key pre-flight validation at task creation (check env var presence before spawning Pi) | B3 | 1 hr |
| **P9-4** | Wire `checkStepAttempts()` into engine EXECUTE case | TD3 | 30 min |
| **P9-5** | Set up GitHub Actions CI: typecheck + unit tests + benchmark | B5 | 2 hrs |

## Tier 2 — Required for internal alpha (Week 2)

| Priority | Item | Addresses | Est. effort |
|---|---|---|---|
| P9-6 | Desktop onboarding: Tauri keychain command + settings page for API key | B1 | 4 hrs |
| P9-7 | Desktop project picker (Tauri folder dialog) + active workspace display | B4, §1.6 | 3 hrs |
| P9-8 | Desktop task list sidebar (multiple tasks visible simultaneously) | B4 | 3 hrs |
| P9-9 | Generalize fix-decision: route through planner.updatePlan on FAIL | TD2, D1 | 4 hrs |
| P9-10 | Package forge-serve as standalone binary (esbuild bundle or Bun compile) | B7 | 4 hrs |

## Tier 3 — Required for external beta (Week 3-4)

| Priority | Item | Addresses | Est. effort |
|---|---|---|---|
| P9-11 | Rename piSessionId → runtimeSessionId with JSON migration | TD1 | 2 hrs |
| P9-12 | Extract per-state handlers from engine.ts monolith | TD8 | 6 hrs |
| P9-13 | Codegen shared types from core (eliminate mirror sync debt) | TD6 | 4 hrs |
| P9-14 | DAG cycle detection in applyPlanOps | TD11 | 1 hr |
| P9-15 | File locking for workspace access | TD10 | 4 hrs |
| P9-16 | Move demos to tests/examples directory | TD7 | 1 hr |
| P9-17 | Event log rotation (size cap + archive) | TD5 | 2 hrs |
| P9-18 | maxConcurrency exposed via CLI flag and API param | TD12 | 30 min |

---

# 5. Security Boundary Summary

| Layer | Mechanism | Status |
|---|---|---|
| Process isolation | Pi subprocess per task; crash doesn't affect Forge | ✅ |
| Working directory confinement | Pi cwd locked to task workspace | ✅ |
| API key storage | Env vars only; injected at spawn; never logged/persisted by Forge | ✅ |
| server.json permissions | mode 0600 | ✅ |
| Loopback binding | Server binds 127.0.0.1 only | ✅ |
| Bearer token auth | All routes except /health | ✅ |
| Key rotation | Not supported; restart required after key change | ⚠️ |
| Tool-level sandboxing | NOT implemented (Pi runs with user permissions) | 🔴 Documented limitation |
| Network isolation | Pi can make arbitrary network calls via bash tool | 🔴 By design (coding agent needs network) |

---

# 6. Metrics Summary

| Metric | Value |
|---|---|
| Total source files | 91 (src 73 + desktop 7 + ui 11) |
| Total source lines | ~7,789 (src 6,439 + desktop 407 + ui 943) |
| Unit tests | 27 pass / 0 fail |
| Integration demos | 10 (all passing) |
| Benchmark golden tasks | 5/5 success rate |
| Interfaces frozen | AgentRuntime, Planner, Evaluator |
| State machine states | 10 (READY→…→COMPLETE/REVIEW_REQUIRED/FAILED) |
| Event protocol version | 1 (seq/timestamp/type/payload) |
| Known amendments requested | A-1 through A-7 |
| Security limitations documented | 2 (tool sandboxing, network isolation) |

---

# 7. Verdict

Forge Alpha is **architecturally sound** — the layered separation (Core/Orchestrator/Runtime seam/Adapter) has been validated by seam-test, crash-recovery, benchmark, and real-Pi integration. The event protocol, verification system, and evaluation framework are deterministic and tested.

The productization gap is concentrated in three areas:
1. **Zero-touch onboarding** (B1/B4/B7): a user cannot install, configure, and run without reading source code.
2. **Resilient planning** (B2/B3/TD2/TD3): the system degrades catastrophically when the LLM misbehaves, rather than gracefully.
3. **Operational readiness** (B5/B6/TD9): hardcoded paths and absent CI mean the system works on exactly one machine with no regression safety net.

All three are addressable within 1–2 weeks of focused work following the P9 priority ranking above. No architectural changes are required.
