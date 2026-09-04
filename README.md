# Forge

An open-source, desktop-first **engineering agent**. Give it a goal, and Forge
plans the work, executes it through an agent runtime, verifies the result with
real commands, and shows exactly what changed — with you in control.

Forge is not a chatbot and not a coding-assistant wrapper. It is an engineering
orchestration system built on top of a replaceable Agent Runtime.

> **Status: Alpha, under active development.** The core lifecycle, verification,
> recovery and memory layers work; real-world task success still depends heavily
> on the model and runtime you pair it with. See [Known issues](#known-issues).

---

## Architecture

Forge separates *deciding what should happen* from *performing the action*:

```
Forge (decides)                     Runtime (performs)
─────────────────                   ──────────────────
Task lifecycle                      LLM turns
Planning                            Tool calls
Execution management                File edits
Verification                        Commands
Recovery                            ...
Memory
        │                                   │
        └────────► AgentRuntime (interface) ─┘
                          │
                    Pi runtime adapter
                          │
                        Pi
```

Because everything above the `AgentRuntime` interface is runtime-agnostic,
the runtime underneath stays replaceable. Today Forge ships a **Pi** adapter.

End to end:

```
Desktop (React / Tauri v2)
        │  HTTP + SSE
   forge serve (Node sidecar)
        │
   TaskManager ──► Orchestrator (state machine)
        │              UNDERSTAND → PLAN → EXECUTE → OBSERVE → FIX → COMPLETE
        │
   AgentRuntime ──► Pi subprocess (NDJSON RPC) ──► Model provider
```

## Task lifecycle

```
READY → UNDERSTAND → PLAN → EXECUTE → OBSERVE ──┬──► EVALUATE → COMPLETE
                          ▲                     │
                          └──────── FIX ────────┘
```

Nothing completes on the model's word alone: a step is done only when its
success criteria pass (`file_exists`, `file_contains`, `command_exit_zero`,
`test_pass`, ...). Failures go through a bounded FIX budget, then surface.

## Conversation vs Engineering Task

Not every input is a task. Forge routes the first message of a session:

```
user input → Intent Router (server-side mini completion)
                 ├─ conversation → one model call, plain reply, lightweight session record
                 └─ task         → full lifecycle: plan → execute → verify → complete
```

Chat stays chat (no fake plans, no fake verification steps); real engineering
requests get the full pipeline.

## Safety

- **Guard**: capability-based policy on every tool call — `read/write/edit`
  allowed; `bash`, network and git writes ask; destructive actions denied and
  terminate the task. "Always allow" writes a rule to `~/.forge/guard.json`.
- **In-place execution**: tasks run in the project directory you selected, not a
  sandboxed copy — which is exactly why approvals exist.
- **Diff & Undo**: file writes are journalled before they happen; the desktop
  shows the diff and can restore it.

## Getting started

Requirements: Node 22+, Rust (for the desktop shell), and **Pi** installed as
the agent runtime (Pi is a separate project, not vendored here).

```bash
# Desktop app
cd desktop
npm install
npm run tauri dev

# Or run the server only
npx tsx src/cli/serve.ts --port 5300 --runtime pi

# Or run a single task from the CLI
npx tsx src/cli/run.ts run "create a TypeScript utility module with tests"
```

Configure a provider in the app's Settings (kind, API key, base URL, model), or
by writing `~/.forge/forge-config.json`.

## Development

```bash
npm run typecheck              # server + core typecheck
cd desktop && npm run typecheck
bash scripts/release-check.sh  # typecheck + unit tests + integration + fresh-install (23 checks)
```

Design notes live in `docs/`, engineering rules in `AGENTS.md`, and the
product direction in `ROADMAP.md`.

## Known issues

- Streaming CJK corruption (mitigated): with some providers the streamed
  `text_delta` events arrive with character reordering, but the runtime's
  final `message_end` message is clean. Forge now replaces accumulated deltas
  with the authoritative final text at every consumption point (turn result,
  conversation history, desktop view), so corrupted streaming self-corrects
  when a message completes. The root cause still lives in the runtime's
  streaming adapter. `docs/19-PI-UPSTREAM-ISSUES.md` tracks it.
- Real-task success rate varies a lot by model; weak agentic models produce
  plans they cannot finish. Verification will catch it, but the task fails.

## Layout

```
src/           Forge core: orchestrator, planner, runtime interface, server, guard, memory
desktop/       Tauri v2 + React desktop app
scripts/       release verification
docs/          design & architecture notes
benchmark/     golden task benchmarks
```

## License

MIT — see [LICENSE](LICENSE).
