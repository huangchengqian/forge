# Forge Guard — Tool Permission Policy (docs/17)

> Status: implemented (9.6.4). Zero Pi upstream changes; loaded via `--extension`.
> Files: `src/guard/policy.ts` (model + evaluation), `src/guard/extension.ts` (Pi extension entry),
> `src/guard/index.ts` (`GUARD_ENTRY_PATH`), wired in `src/runtime/pi/pi-adapter.ts`.
> Approvals relay (server routes + Desktop UI) is 9.6.5.

---

# 1. What this is

Forge Guard is a Forge-owned Pi extension that sits on Pi's `tool_call` event and
enforces a capability policy **before** any tool executes. It uses only surfaces Pi
already exposes — no Pi source changes:

- `pi.on("tool_call", handler)` (verified: `packages/agent/src/agent-loop.ts:636`
  honors `{ block, reason, terminate }` from the hook).
- `ctx.ui.confirm(...)` in RPC mode → `extension_ui_request` / `extension_ui_response`
  (verified: `packages/coding-agent/src/modes/rpc/rpc-types.ts:281`).

# 2. Capability model (8 categories, per product spec)

Each tool call classifies into an ordered capability list; the first matching rule
in policy order wins, else the policy default.

| Capability | Tool mapping (Pi built-ins) | Notes |
|---|---|---|
| read | read, grep, ls, find | harmless → allow by default |
| write | write | interim allow → ask in 9.6.5 |
| edit | edit | interim allow → ask in 9.6.5 |
| bash | bash (no destructive/network/git marker) | interim allow → ask in 9.6.5 |
| delete | bash `rm` (non-root) | follows bash |
| network | bash curl/wget/nc/ncat/telnet/ftp/ssh/scp/rsync | interim allow → ask in 9.6.5 |
| git | bash `git ...` (status/diff/log/show/branch → allow; push/reset/clean --force → destructive deny) | |
| destructive | bash `sudo`, `mkfs`, `dd of=/dev`, shutdown/reboot, `rm -rf /`, fork bomb, `git push --force` | **deny + terminate** by default |
| unknown | any other tool | policy default (ask) |

Priority: destructive > network > git > bash > write > edit > read.

# 3. Policy schema (`~/.forge/guard.json`, user-overridable)

```json
{
  "version": 1,
  "default": "ask",
  "rules": [
    { "id": "read-allow",        "capability": "read",        "decision": "allow" },
    { "id": "destructive-deny",  "capability": "destructive", "decision": "deny", "terminate": true },
    { "id": "git-read",          "capability": "git", "contains": "status", "decision": "allow" },
    { "id": "git-ask",           "capability": "git", "decision": "ask" },
    { "id": "write-ask",         "capability": "write",       "decision": "ask" }
  ]
}
```

- Rule fields: `id?`, `capability` (required), `tools?` (exact tool names to scope),
  `contains?` (substring of JSON.stringify(input) — e.g. match bash commands),
  `decision` (`allow` | `ask` | `deny`), `terminate?` (deny only).
- First rule matching (capability ∈ classification ∧ tools match ∧ contains match) wins.
- `default` applies when nothing matches. Missing/invalid file → built-in defaults.
- Path: `FORGE_GUARD_POLICY` env, else `~/.forge/guard.json`.

# 4. Defaults (updated 9.6.8 — noise reduction)

File writes are covered by the undo journal (restorable), so write/edit no
longer ask by default. This is the main approval-noise reduction:

| Capability | Default |
|---|---|
| read | allow |
| destructive (`sudo`, `mkfs`, `dd of=/dev`, `rm -rf /`, fork bomb, `git push --force`, ...) | **deny + terminate** |
| git status/diff/log/show/branch | allow |
| **write / edit** | **allow** (undo-journal backed) |
| git (other: commit, merge, push...) | ask |
| bash | ask |
| network (curl/wget/ssh/scp/rsync...) | ask |
| unknown tool | ask (policy default) |

User-overridable via `~/.forge/guard.json` (`FORGE_GUARD_POLICY`).

## 4b. "Always allow" (approval memory)

The Desktop approval card has an **Always** button (Deny / Always / Approve).
Clicking Always:
1. resolves the current approval (tool proceeds now), and
2. persists a rule to `~/.forge/guard.json`:
   `{ capability: <bash|network|git|...>, contains: "<command>", decision: "allow" }`.

The policy file is re-read on **every tool call** (the guard extension no longer
caches it at process start), so the rule takes effect immediately — the same
command stops asking on the next call. Specific `contains` rules always win
over generic ask/deny rules for the same capability (two-pass match).

Destructive operations are never "always-allow"-able; they stay deny+terminate.

# 4a. Headless fallback (`FORGE_GUARD_ASK_FALLBACK`)

An `ask` decision needs a human. Forge sets this env when spawning Pi:

- `block` (default) — server path with an approval relay: emit `extension_ui_request`
  and block until the Desktop answers (60s timeout → auto-deny).
- `allow` — headless CLI runs (no UI surface): pass through without prompting.
  Set by `PiRuntime` automatically: no `onApprovalRequest` listener → `allow`.

# 5. Extension behavior (fail-closed)

- allow → pass through (no prompt).
- deny → `{ block: true, reason, terminate? }`.
- ask → `ctx.ui.confirm(...)`:
  - confirmed → pass; rejected → block.
  - no UI available (`hasUI=false`) → block.
  - no response within 60s → block (timeout resolves false).
  - any extension/policy error → block.

# 6. Where it lives in the stack

```
Pi subprocess (rpc-entry.js --extension <src/guard/extension.ts>)
  └─ guard extension
       ├─ loadPolicy(FORGE_GUARD_POLICY ?? ~/.forge/guard.json)
       ├─ pi.on("tool_call") → evaluateToolCall(policy, tool, input)
       ├─ allow  → pass
       ├─ deny   → block (+terminate)
       └─ ask    → ctx.ui.confirm → extension_ui_request
                     → forge serve (ApprovalHub, TaskManager relay)
                     → Desktop ApprovalCenter (Approve/Deny card)
                     → extension_ui_response → tool proceeds or blocks
```

Relay (9.6.5):

- `src/server/approval-hub.ts` — pending approval registry.
- `TaskManager.approve/deny/listApprovals` — resolve via `PiRuntime.resolveApproval`.
- HTTP: `GET /tasks/:id/approvals`, `POST /tasks/:id/approvals/:requestId/{approve,deny}`.
- Desktop: `desktop/src/components/ApprovalCenter.tsx` (polling card stack, wired in App).

# 7. Test coverage

- `src/guard/policy.test.ts` — classification, rule precedence, contains/tools
  scoping, defaults, policy file loading.
- `src/guard/extension.test.ts` — handler allow/deny/ask/confirm/reject/no-UI/
  fail-closed + ask-fallback modes.
- `src/server/approval-hub.test.ts` — record/list/mark.
- `src/server/task-manager.test.ts` — approval relay (list, approve on fake
  runtime, inactive task).
- Real-Pi boot smoke: `rpc-entry.js --extension src/guard/extension.ts` boots
  clean in both ask-fallback modes (verified manually, not a unit test).
- Full ask→UI→respond loop: requires a real model run (drive from Desktop).
