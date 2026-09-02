# Amendment A-2 — In-Place Execution (workspaceRoot = exact directory)

> Status: **PROPOSED** — pending approval per docs/11 §7.
> Author: Forge lead developer. Decision owner: product manager (decided 2026-08-30: in-place execution; git is NOT a requirement).
> Supersedes the shadow-workspace default of docs/12 §2.2 for the alpha. The "Apply to project" flow (docs/12 §2.2) is retired for alpha; diff review becomes display-only (git diff or undo journal), no patch application.
> Scope: this amendment changes the `AgentRuntime` interface contract, the Pi adapter, the TaskSession schema (v2 → v3), and adds a tool-permission gate. It does NOT touch the orchestrator state machine, event protocol v1, or the evaluation/verification systems.

---

# 1. Decision

The product manager decided:

- Tasks execute **in place** in the user's project directory (no shadow copy).
- Forge must be a Codex-like agent; taking the product position seriously means the agent works on the real repository.
- **git is not a prerequisite.** Safety must not silently depend on the project being a git repo.

"魄力" (boldness) is the product position; it does not mean "bare". This amendment pairs in-place execution with a real, Forge-owned tool-permission gate (discovered to be available in Pi today, see §3) and a file-level undo journal that does not require git.

---

# 2. What changes

## 2.1 `AgentRuntime` interface — semantics change (frozen surface, amended here)

`CreateSessionOptions.workspaceRoot` semantics change from:

> "Base workspace root; the adapter derives the session's working directory under it."

to:

> "Exact working directory. The adapter MUST use it as-is; it MUST NOT create or derive a subdirectory."

Field renamed `workspaceRoot` → `workspace` (mechanical; single consumer is the Pi adapter + FakeRuntime).

Consequences:

- `PiRuntime.createSession` no longer calls `ensureTaskDir(forgeHome, taskId)`; `session.directory = opts.workspace` exactly.
- **`PiRuntime.destroy` MUST NOT delete the working directory.** Today it does `rm(pi.directory, {recursive:true, force:true})` — an in-place task would delete the user's repository. This is a safety red line and is fixed in the same commit as the semantics change.
- `OrchestratorOptions` gains the task's workspace path; `engine.ts ensureSession()` passes it instead of the hardcoded `FORGE_HOME`.

## 2.2 TaskSession schema v2 → v3

New fields:

```
workspacePath: string | null   // exact execution directory (project.path)
projectId:     string | null   // projects.json record id
```

- Migration `v2 → v3`: backfill both fields to `null`; legacy tasks are display-only and can no longer be resumed in-place (resume of a v2 task with null workspacePath → 409 "task has no workspace; resume unsupported after A-2 migration").
- The persisted schema already carries `schemaVersion = 2` (docs/01 §15); bump to 3. This is part of this amendment's scope (persistence contract is otherwise frozen).

## 2.3 Server surface

- `POST /tasks` accepts `projectId` (optional). TaskManager resolves the path via ProjectsRegistry; missing/invalid project → 400.
- New: `POST /tasks/:id/preflight` — check workspace writable, no concurrent lock, Pi bootable, provider env present (addresses audit B3: fail fast before burning FIX budget).
- New: `GET /tasks/:id/diff` — if the workspace is a git repo, return `git diff` (working tree vs HEAD) produced at the task's latest state; otherwise return the undo-journal change list (relative paths + restore-ability flags).
- `POST /projects/:id/apply` (docs/12 §2.2) is **dropped from alpha** — there is nothing to apply; changes are already in place.
- Per-project concurrency lock: TaskManager keeps an in-memory advisory lock per absolute project path (`~/.forge/locks/<sha256(path)>.lock`). Second concurrent task on the same path → 409. (Audit TD10.)

## 2.4 Tool-permission gate — `forge-guard` extension (new)

A Forge-owned Pi extension loaded via `--extension <path>` in `spawnPi`. It implements the Pi extension `tool_call` event (see §3 for the discovered surface) and applies a policy file `~/.forge/guard.json`:

| Policy rule | Meaning |
|---|---|
| `deny` (path/tool/substring) | hard `{block: true, reason}` — no user prompt, recorded as event |
| `allow` (path/tool/substring) | pass without prompting |
| `prompt` (default) | emit `extension_ui_request` (method `approve`) → Forge server forwards to Desktop → user approves/denies → `extension_ui_response` |
| `terminate` rules | e.g. `rm -rf /`, `git push` — block **and** terminate the run (agent-loop supports `terminate: true`) |

Defaults shipped: `deny` destructive/network-outbound patterns (`rm -rf`, `git push`, `sudo`), `prompt` on `bash`, `write`, `edit`, `delete` (or configurable to `allow` in "raw-trust" mode). Policy is per-workspace overridable (project-level `forge.guard.json` in the workspace, loaded by the extension; note: project-provided policy is a trust decision — shipped default only honors `~/.forge/guard.json`).

## 2.5 Undo journal (git-independent rollback)

Because write/delete/bash go through the gate, Forge records before-images:

- For intercepted `write`/`edit`/`delete` on files: copy original to `~/.forge/undo/<taskId>/<relpath>.bak` **before** the tool executes (the gate runs before execution — that is the whole point of the hook).
- For `bash`: cannot reliably parse side effects; destructive bash either matches a `deny` rule, prompts, or (recommended) records `git diff` when the workspace is a git repo.
- Restore endpoint: `POST /tasks/:id/undo` restores all journal entries for the task. Honest limitation: no journal can reconstruct arbitrary bash effects — that is exactly why the gate (not the journal) is the primary safety layer, with the journal as belt-and-braces for file tools.

---

# 3. Technical due diligence — the gate already exists in Pi (no upstream change)

Verified in `/Users/hcq/forge/pi` source (read-only audit, 2026-08-30):

1. **Agent core can veto any tool call.**
   `packages/agent/src/agent-loop.ts:636`:
   ```ts
   if (beforeResult?.block) {
     const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
     if (beforeResult.terminate === true) result.terminate = true;
     return { kind: "immediate", result, isError: true };
   }
   ```
2. **The RPC client can respond interactively.**
   `packages/coding-agent/src/modes/rpc/rpc-types.ts:281`:
   ```ts
   export type RpcExtensionUIResponse =
     | { type: "extension_ui_response"; id: string; value: string }
     | { type: "extension_ui_response"; id: string; confirmed: boolean }
     | { type: "extension_ui_response"; id: string; cancelled: true };
   ```
   The rpc-mode loop accepts `extension_ui_response` (`rpc-mode.ts:769`) and emits `extension_ui_request` events with an id (`rpc-mode.ts:129`).
3. **Extensions are loadable per-process and their `tool_call` handlers can veto.**
   `packages/coding-agent/src/core/extensions/runner.ts:945` short-circuits on `result.block`; extension paths are accepted via CLI `--extension <path>` / `-e` (`src/cli/args.ts:157`); in RPC mode the extension runner is active (the RPC `bash` command itself routes through `session.extensionRunner.emitUserBash`, `rpc-mode.ts:546`).
4. **RPC surface is richer than Forge currently uses (32 commands):** `steer`, `follow_up`, `set_steering_mode`, `fork`, `clone`, `get_tree`, `get_messages`, `bash` (caller-executed, recorded into context), `abort_bash`, etc. Relevant to roadmap A-4 (steering) — Pi already has a steering queue; Forge's steering feature can be a thin interface addition instead of a custom queue.

**Conclusion:** the blocker that docs/12 §2.3 recorded ("beforeToolCall is not exposed over RPC", Amendment A-3) **no longer exists**. The permission gate is implementable today with zero Pi upstream changes by shipping a Forge-owned extension. A-3 is hereby withdrawn and replaced by A-2's guard-extension design.

---

# 4. User flows after A-2

## 4.1 Task runs in place (project = git or not)

```
Desktop: TasksPage → + New Task → pick project (folder dialog) → goal
  → POST /tasks {goal, projectId}
  → TaskManager: lock project path, preflight (writable / lock / provider / Pi)
  → Orchestrator (unchanged state machine)
  → Pi spawned with cwd = project.path + --extension forge-guard
  → guard: deny rules / allow rules / interactive approval (Desktop card)
  → OBSERVE: deterministic verification against project.path
  → Task detail shows: workspace path, guard events, approval history, git diff / journal
```

## 4.2 Approval card (first-class Desktop UX)

```
Pi (guard extension) → extension_ui_request {id, toolName, args, cwd}
  → forge serve → SSE/Task API → Desktop
  → Card: tool, args preview, workspace path, [Allow once] [Allow always] [Deny] [Deny and terminate]
  → extension_ui_response {id, confirmed} → guard passes → tool executes
```

Approval is a runtime control, not a state-machine change — it needs no `WAITING_APPROVAL` state (A-1 stays beta, unchanged).

## 4.3 No git? No problem

- File tools: undo journal restores originals.
- Bash: gated; journal captures nothing for arbitrary bash — UI says so honestly.
- git repos get automatic `git diff` view + "restore via git" path as a bonus, never a requirement.

---

# 5. Implementation plan — Phase 9.6 (in-place execution)

Each step compiles, has a seam/unit test, and does not touch the frozen state machine.

| # | Step | Files | Exit criterion |
|---|---|---|---|
| 9.6.1 | Interface + adapter in-place semantics; **destroy() no longer deletes directory**; FakeRuntime parity | `runtime/interface.ts`, `runtime/pi/pi-adapter.ts`, `runtime/pi/pi-paths.ts`, `runtime/fake-runtime.ts` | seam-test: session.directory === requested path; destroy leaves directory intact |
| 9.6.2 | Schema v3: `workspacePath`, `projectId` + migration v2→v3; v2 resume → 409 | `core/types/task-session.ts`, `core/persistence/schema.ts`, `task-store.ts` | migration test v2→v3; legacy resume blocked with clear message |
| 9.6.3 | TaskManager: projectId resolution, per-project lock, preflight endpoint | `server/task-manager.ts`, `server/projects.ts`, `server/http-server.ts`, `server/runtime-readiness.ts` | concurrent create on same path → 409; preflight returns actionable failures (audit B3) |
| 9.6.4 | `forge-guard` extension: policy engine, veto path, interactive approval RPC round-trip, undo journal for file tools | new `src/guard/` (extension) + `runtime/pi/pi-process.ts` (spawn `--extension`), `server/` approval relay | integration: guard blocks `rm -rf` without prompt; approves flow via `extension_ui_response`; journal restores a written file |
| 9.6.5 | Desktop: + New Task modal (project + goal), approval card, workspace/diff display | `desktop/src/` (TasksPage modal, new ApprovalCard, TaskDetail) | full in-place golden task driven from Desktop incl. one approval |
| 9.6.6 | Diff surface: `GET /tasks/:id/diff` (git diff or journal list); `POST /tasks/:id/undo` | `server/http-server.ts`, `server/diff.ts` (new) | non-git workspace shows journal change list; git workspace shows git diff |
| 9.6.7 | UX correction completion (§31): first launch lands on Main Workspace; Wizard replaced by dismissible, config-free Welcome | `desktop/src/App.tsx`, `Wizard.tsx` | fresh profile: launch → Main Workspace, no config gate; task creation prompts for model/project only at run time |

Phase 9.7 (roadmap, not this amendment): steering via Pi's native `steer` (thin interface addition), git-branch checkpoint mode for git workspaces.

---

# 6. Risks

| Risk | Mitigation |
|---|---|
| In-place agent damages user files | Guard gate is the primary layer (deny defaults, terminate on hard rules); undo journal secondary; preflight checks |
| Approval fatigue blocks autonomous feel | Policy file: `allow` rules learned from "Allow always"; raw-trust mode; per-workspace policy override (documented trust boundary) |
| Two tasks on same directory race (TD10) | Per-project advisory lock → 409 |
| `destroy()` regression deletes user directory | Red-line test in 9.6.1 seam suite; code review checklist item |
| Guard extension API drift (Pi upstream) | Guard pins to `tool_call` event + `extension_ui_request/response` only; both observed in current source; seam-test catches breakage on Pi upgrade |
| Non-git rollback is partial (bash side effects) | Honest UI copy; gate (not journal) is the safety story; git is recommended not required |

# 7. Freeze statement

Amended surfaces, and only these:

1. `CreateSessionOptions.workspaceRoot` semantics (interface doc contract).
2. TaskSession schema v2 → v3 (additive fields).
3. Pi adapter spawn args (additive `--extension`).

Not touched: orchestrator state machine, event protocol v1 envelope, verification system, evaluation system, `AgentRuntime` method signatures (only options semantics). Pi upstream: zero changes.
