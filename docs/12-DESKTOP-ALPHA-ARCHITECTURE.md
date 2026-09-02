# Forge Desktop Alpha — Architecture Design Freeze

> Status: design freeze for Phase 7.3 (Desktop Alpha). No code in this phase.
> Basis: audited state of forge core at Phase 7.2 (`src` 62 files, `benchmark/`, `ui/src` 11 files / 943 LOC, `forge serve` HTTP+SSE from 7.1).
> Hard constraints honored: Orchestrator, AgentRuntime interface, state machine, and Pi Adapter are NOT modified. Everything below is either additive server surface, Tauri shell, or UI evolution.
> Related: docs/11 §7 freeze statement (amendment process), docs/09/10.

---

# 1. Desktop Architecture

## 1.1 Topology

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri App (Rust shell)                                            │
│  • window / tray / native dialogs / keychain / auto-update        │
│  • SidecarSupervisor: spawn+watch forge-serve, restart w/ resume  │
│  • Handshake: reads ~/.forge/server.json {port, token, pid}       │
│      │                                                            │
│      │ commands/events (Tauri IPC)     ┌────────────────────┐    │
│      ├───────────────────────────────►│ WebView (React UI)  │    │
│      │   window.*, dialog.*, keychain  │ existing ui/ evolved│    │
│      │                                 └─────────┬──────────┘    │
└──────┼───────────────────────────────────────────┼───────────────┘
       ▼ spawns + supervises                       │ HTTP/SSE (+token)
┌──────────────────────────────────────────────────────────────────┐
│ forge serve  (Node sidecar — the 7.1 server, unmodified shape)    │
│  TaskManager · EventBus · replay · recovery · memory routes*      │
└──────────────┬───────────────────────────────────────────────────┘
               ▼ subprocess per task (unchanged)
        Pi coding-agent --mode rpc  →  Provider API
               ▼
   ~/.forge/  tasks/*.json · events/*.jsonl · memory.json · projects.json*
                                                        (* = additive)
```

**Decision: sidecar, not embedded core.**

| Option | Verdict | Reason |
|---|---|---|
| Rust rewrite of orchestrator | ✗ | Violates "don't modify Core"; duplicates a proven TS system |
| napi-rs embed of core INTO the Tauri process | ✗ (beta+) | Couples lifecycles: a Pi/tool crash or native addon fault kills the whole app; loses the crash-recovery story proven in 7.1 |
| **Node sidecar running `forge serve`** | ✓ | Zero core changes; crash isolation preserved (sidecar dies → Rust supervisor relaunches → TaskRecoveryService resumes); reuse of every 7.1 endpoint as-is |

Packaging note: ship a self-contained server binary (esbuild bundle → single JS run by bundled Node, or Bun-compiled `forge-serve`) so end users need no Node install. The sidecar contract is identical either way.

## 1.2 Process lifecycle

```
app launch
  → Tauri spawns sidecar (forge serve --port 0)
  → sidecar binds ephemeral port, generates one-time token,
    writes ~/.forge/server.json {port, token, pid}, prints same to stdout
  → Rust reads file/stdout, stores token, injects into webview bootstrap
  → webview calls http://127.0.0.1:<port>/... with Authorization: Bearer <token>
on sidecar exit (crash):
  → Rust detects within 1s (waitpid/health poll)
  → relaunch; on boot the NEW sidecar runs recovery sweep:
      listTasks() → non-terminal tasks → auto POST-resume each (opt-in flag)
on app quit:
  → SIGTERM sidecar (graceful); tasks persist; next launch offers "resume N interrupted tasks"
```

This reuses exactly the crash semantics demonstrated in serve-demo; the only new artifact is the handshake file and token check (additive middleware in http-server).

---

# 2. Workspace Model

## 2.1 Project registry

New file `~/.forge/projects.json` (additive, owned by the SERVER layer):

```json
{ "version": 1, "projects": [
  { "id": "prj_...", "name": "my-app", "path": "/Users/me/code/my-app",
    "createdAt": 0, "lastOpenedAt": 0 }
]}
```

- Projects are registered via native folder picker (Tauri command) — never typed paths.
- One project is "active" per task submission; TaskSession.metadata gains an optional `projectId` note via the existing metadata escape hatch at the SERVER layer (server composes goal preamble + records mapping in projects.json ↔ taskIds index). No TaskSession schema change required for alpha.
- Multiple projects fully supported: tasks are already directory-scoped; the registry only adds naming/discovery.

## 2.2 Execution location — two models

| Model | Mechanics | Alpha? |
|---|---|---|
| **Shadow workspace** (recommended for alpha) | Tasks keep executing under `<forgeHome>/tasks/<id>/workspace` (current behavior, zero change). Desktop adds **"Apply to project"**: renders `git diff` of the task workspace onto the registered project as a reviewed patch (apply / apply-and-commit / discard). | ✅ |
| **In-place execution** | session.directory = project.path directly. Requires ONE interface amendment: `CreateSessionOptions.workspaceRoot` semantics become "exact directory, do not derive" (pi-adapter stops appending taskId). | beta — logged as Amendment A-2 |

Rationale: shadow mode makes alpha safe by construction (user repos physically untouchable until a human applies a diff), matches the propose→review→apply mental model of Claude Code/Cursor, and requires zero seam changes. In-place is the natural beta step once A-2 is approved through the docs/11 amendment process.

## 2.3 Permissions model (layered)

| Layer | Mechanism | Where enforced |
|---|---|---|
| Provider keys | OS keychain (Tauri stronghold/keyring) → injected as env into sidecar spawn only; never stored by Forge, never sent to webview | Rust shell |
| Filesystem reach | cwd confinement of Pi tools (exists today) + shadow-workspace default | Pi adapter (existing) |
| Tool policy (allow bash? network?) | NOT enforceable through current RPC surface — alpha substitutes **step-gate approvals** (§3) and documents raw-trust mode | deferred |
| Server access | localhost bearer token from handshake file (closes 7.1 limitation S5) | http-server middleware (additive) |

Honest limitation carried forward: fine-grained tool permissions require the Pi-side hook surface (beforeToolCall is not exposed over RPC). Tracked as Amendment A-3; containerized execution (Pi's own gondolin/docker patterns) is the alternative alpha story if hard isolation is demanded earlier.

---

# 3. Human–Agent Interaction

## 3.1 What ships in alpha (zero core change)

| Capability | Mechanism (all existing seams) |
|---|---|
| **Plan review** | Live plan view during UNDERSTAND→PLAN (SSE plan_created); after completion, full plan with statuses. User judgment is retrospective in alpha. |
| **Intervention: stop** | POST cancel (abort+destroy) — proven. UI button maps 1:1. |
| **Intervention: redirect** | Cancel → user edits goal → new task. Memory injection (below) carries the correction forward. |
| **Intervention: resume** | POST resume after crash/cancel-at-nonterminal — proven in 7.1 demo. |
| **Context injection** | Memory authoring UI writes `{type: DECISION\|PROJECT_FACT, source: USER, confidence: 1.0}` items BEFORE submitting a task; engine's UNDERSTAND retrieval injects matching items into planning automatically. This is the highest-leverage steering tool available today and needs only additive `/memory` routes. |
| **Review gate (post-hoc)** | REVIEW_REQUIRED terminal surfaces findings + evidence; operator decision recorded in UI; "apply patch" is the human approval act in shadow mode. |

## 3.2 Interaction roadmap (requires amendments — requested here, not implemented)

| Amendment | Change | Unlocks |
|---|---|---|
| **A-1 WAITING_APPROVAL state** | OBSERVE→…: PLAN emits plan_created then transitions to WAITING_APPROVAL when `OrchestratorOptions.gate.afterPlan=true`; approve→EXECUTE, reject→FAILED(reason), edit→planner.updatePlan path | True pre-execution plan approval inside the engine |
| **A-4 Steering** | Expose mid-run message injection: manager holds queued steer messages; engine polls between states (mirrors Pi's own steer concept at Forge level) | "Stop, do X instead" without losing progress |
| **A-5 Human approval checkpoints** | Per-step `approvalRequired` flag; EXECUTE halts into WAITING_APPROVAL before destructive steps | Fine-grained gating (replaces blunt tool-policy gap for alpha) |

Alpha UX therefore trains users on the mental model (plan → evidence → apply) while A-1/A-4/A-5 upgrade the same UI affordances to inline control once unfrozen.

---

# 4. Event → UI Mapping

Server additions (additive): event envelope gains monotonic `seq` per task (fixes 7.1 S2 overlap/dedupe); `GET /memory`, `POST /memory`, `GET /memory/search?q=`, project CRUD routes join the API table.

| UI region (existing component) | Data source (endpoint/event) | Mapping notes |
|---|---|---|
| TimelineView | SSE history+live `state_changed`, `step_started/verified`, `fix_started`, `plan_created/revised`, `evaluation_*` | Persisted UPPER_SNAKE history events render through the same label map as live camelCase events (serve-demo describe() pattern promoted into shared renderer); seq dedupes overlap |
| PlanView (Plan) | GET snapshot `plan.steps[]` + `plan_created/plan_revised` events | Status pills PENDING/READY/RUNNING/VERIFIED/FAILED/CANCELLED; dependencies rendered as badges in alpha, DAG graph in beta |
| Execution detail (RuntimeDetail) | `pi_event` stream | Alpha: collapsed feed of tool name + one-line arg summary (RuntimeDetail summarize() exists); beta: TurnResult.toolCalls (Amendment A-6) gives structured toolCalls |
| VerificationPanel | snapshot `observations[]` + `OBSERVATION_CREATED` live | Row per observation: PASS/FAIL pill, per-criterion kind/message/exitCode, attempt number, failureReason banner |
| EvaluationPanel (new small panel) | `lastEvaluation` + `evaluation_completed` | Score gauge, status chip (PASS/WARNING/REVIEW_REQUIRED), findings grouped by rule with severity, evidence list; REVIEW_REQUIRED turns into the apply-patch decision screen |
| TaskHeader | snapshot + `task_started/completed/failed` | Goal/state chip/duration/fixCount/id (already built) |
| MemoryPanel → Memory Workspace | `/memory*` routes | See §5 |
| ProjectsSidebar (new) | `/projects*` routes + Tauri folder picker | Multi-project switcher; per-project task filter |

Non-negotiables restated: UI remains a pure projection — it never writes TaskSession fields directly; all mutations flow through task/memory/project APIs; state authority stays with the persisted snapshot + engine.

---

# 5. Memory UX

## 5.1 Presentation

Three fixed scopes rendered as tabs mirroring MEMORY_TYPES:

- **Project facts** (PROJECT_FACT) — "what this repo is": architecture lines, conventions, validated environment facts. Badge: confidence (0–1), source (VERIFICATION/OBSERVATION/USER/REPO), linked taskRefs → clicking jumps to that task's timeline.
- **Decisions** (DECISION) — user-authored standing instructions ("always use pnpm", "REST not GraphQL"). Alpha's primary authoring target.
- **Failures & solutions** (FAILURE_PATTERN / SOLUTION) — auto-extracted post-task; read-only in alpha, editable in beta.

Each item card: content, keyword chips, created/updated, confidence bar, source icon, provenance link.

## 5.2 Authoring & flow

1. **Pre-task injection editor**: on task creation screen, a search box queries `/memory/search?q=<goal>` and shows "N relevant memories will be considered". User may pin/edit/add items right there — this is the context-injection UX promised in §3.
2. **Inline capture**: any timeline row offers "Save as decision/fact" → prefills authoring modal (source=USER).
3. **Editing rules (alpha)**: add + view + search. Edit/delete is **beta** (store is append-only today; deletion requires tombstone support = additive storage change listed for D1, not core).

Why this matters: memory authoring converts the user from spectator to teacher with ZERO engine work — retrieval already feeds UNDERSTAND prompts (Phase 3 wiring), and confidence-weighted keyword match is deterministic.

---

# 6. Migration Plan (React UI → Desktop)

## 6.0 Current assets (audited)

`ui/src`: App.tsx, main.tsx, components×6 (TaskHeader/PlanView/TimelineView/VerificationPanel/MemoryPanel/RuntimeDetail), lib/{eventClient,useUiStore}, shared/types (mirror). Backend coupling today: relative `/events` `/snapshot` via Vite proxy + FORGE_BACKEND_URL override. All panels consume events/snapshot only — no core imports. **Verdict: the React tree migrates nearly verbatim; the proxy assumption is the single code touchpoint.**

## 6.1 Staged plan

| Stage | Scope | Exit criteria |
|---|---|---|
| **D1 — server hardening** (no Tauri) | seq envelope + dedupe; `/memory` GET/POST/search; `/projects` CRUD; bearer-token middleware; handshake file writer; recovery-sweep-on-boot flag | serve-demo green + new routes curl-tested; token-less requests 401 |
| **D2 — Tauri skeleton** | Empty window; sidecar spawn of packaged forge-serve; handshake read; keychain set/get commands; auto-restart w/ resume sweep; tray (running-task count) | Kill -9 sidecar → app auto-recovers and a previously-running task reaches COMPLETE |
| **D3 — UI port** | Move `ui/` into Tauri webview; boot config supplies `{baseUrl, token}` (replaces Vite proxy); add ProjectsSidebar, EvaluationPanel, Memory authoring, Apply-to-project flow (diff viewer via webview, git apply executed by sidecar route `/projects/:id/apply`) | Full golden-task run driven entirely from desktop UI incl. crash-recovery resume |
| **D4 — alpha release** | macOS packaging (universal, codesign+notarize), updater, crash reporter (opt-in), first-visit onboarding (pick provider, store key, register first project) | External user completes A-add-divide equivalent end-to-end on their machine |

Build order rationale: D1 is pure additive server work usable immediately by power users via CLI; D2 proves the riskiest integration (process supervision) before UI investment; D3 is mostly mechanical because panels already speak events; D4 is polish gates only.

## 6.2 Shared-types strategy

ui/src/shared/types mirror graduates to a generated artifact: a tiny `forge-schema` build step emits `shared/types.ts` from core types (single-source-of-truth, removes manual sync debt flagged since Phase 4 U3). Mechanical codegen — not a core change.

## 6.3 Amendment ledger (requests against docs/11 freeze)

| ID | Requested change | Target phase |
|---|---|---|
| A-1 | WAITING_APPROVAL state + gate option | beta (interaction upgrade) |
| A-2 | workspaceRoot = exact directory semantics | beta (in-place execution) |
| A-3 | Tool-permission hooks over RPC | beta/beta+ (with Pi upstream discussion) |
| A-4 | Mid-run steering queue | beta |
| A-5 | Per-step approval flags | beta |
| A-6 | TurnResult.toolCalls structured payload | D1-adjacent (server-only consumer initially) |
| A-7 | Memory tombstones (delete/archive) | D1 (storage additive) |

Each remains prohibited until approved via the docs/11 §7 process — this document formally submits them.

## 6.4 Alpha risk callouts (delta to docs/11 §6)

| Risk | Note |
|---|---|
| Sidecar port/token race | Handshake file written before listen-ready signal; Rust retries read ≤5s; file perms 0600 |
| Bundled runtime size (~90–120MB with Node/Bun + Pi deps) | Acceptable for alpha; Bun single-file compile evaluated in D2 |
| WebView SSE stability | EventSource over localhost is stable; fallback to chunked-fetch reader (pattern already exists in serve-demo collectSse) behind a flag |
| Shadow-mode confusion | Onboarding must make explicit: "tasks run in a sandbox copy; nothing touches your repo until you press Apply" |
| Windows | Deferred post-alpha (path/keychain divergence) |

---

# Summary

Desktop Alpha = **Tauri shell + sidecar `forge serve` + evolved React projection**, with three deliberate product stances: (1) shadow-workspace safety with human Apply, (2) memory-authoring as the primary steering tool, (3) retrospective review now, inline approval via the A-* amendment ledger next. Every alpha capability rides seams that already exist and have passing demonstrations (serve crash-recovery, memory retrieval injection, evaluation evidence). The core — orchestrator, runtime seam, state machine, Pi adapter — ends this phase exactly as it entered: frozen, unmodified, and independently provable.
