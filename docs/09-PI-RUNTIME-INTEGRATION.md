# Pi Runtime Integration Specification

> Status: Phase 1 implementation spec
> Source of truth: actual `https://github.com/earendil-works/pi.git` (commit `c49906ec7` on `main`, 2026-08-22)
> Related: `DESIGN.md` §3, `docs/03-RUNTIME-PI-INTEGRATION.md`, `AGENTS.md` §4

---

# 1. Purpose

This document defines how Forge calls Pi.

Forge never modifies Pi source. Forge never imports Pi packages. Forge communicates with Pi exclusively over a process boundary using the RPC mode that Pi's `coding-agent` package ships with.

# 2. Why a process boundary

DESIGN.md §3 and AGENTS.md §4 require that Pi be replaceable. The process boundary is the only boundary that gives a real guarantee of replaceability.

The alternatives fail the guarantee:

- Importing Pi packages makes Forge's `node_modules` depend on Pi's package graph. Replacing Pi means rewriting Forge.
- Calling Pi as a long-lived socket or HTTP server ties Forge to a specific Pi wire format. A different runtime with a different protocol would require adapter rewrites regardless.
- Subprocess over stdio is the lowest common denominator. Every modern agent runtime can speak a line-based JSON protocol on stdio. If a future runtime cannot, the adapter is small enough to rewrite.

The process boundary is also a security boundary. Pi's file and shell tools run inside the Pi process. A Pi crash cannot take Forge down. A misbehaving tool call cannot escape the Pi process without going through the JSON parser on stdout.

# 3. Pi's actual shape

Pi is a TypeScript monorepo at `https://github.com/earendil-works/pi.git`.

Relevant packages for Forge:

| Package | Purpose | Forge uses |
|---|---|---|
| `packages/coding-agent` | Coding agent CLI with read/bash/edit/write tools, session management, RPC mode | Subprocess entrypoint |
| `packages/ai` | Unified LLM API with 30+ built-in providers | Indirect (Pi loads it) |
| `packages/agent` | Agent runtime with tool calling and event streaming | Indirect (Pi loads it) |

Forge does not import any of these packages. Forge only spawns the compiled `coding-agent` binary.

Pi's `coding-agent` package exposes two CLI modes:

- Interactive mode (`pi`): terminal UI. Forge does not use.
- RPC mode (`pi --mode rpc`): headless, reads JSON commands from stdin, writes JSON responses and events to stdout.

# 4. Process model

One Pi subprocess per TaskSession. Lifecycle:

```
Forge CLI start
  │
  ├── TaskSession A created
  │   └── spawn pi-coding-agent --mode rpc --cwd /tmp/forge/A --provider X --model Y
  │       │
  │       │ (lifecycle: UNDERSTAND → PLAN → EXECUTE → OBSERVE → COMPLETE)
  │       │
  │       └── kill on TaskSession end
  │
  ├── TaskSession B created (in parallel)
  │   └── spawn pi-coding-agent --mode rpc --cwd /tmp/forge/B ...
  │
  └── Forge CLI exit
      └── SIGTERM all running Pi subprocesses (5s grace, then SIGKILL)
```

Why one process per task instead of one shared process:

- Each task gets a private SessionManager. No contention.
- A Pi crash in one task does not affect other tasks.
- Working directory is fixed at spawn time. Reusing a process across tasks would require switching cwd, which Pi does not support cleanly.
- Memory isolation. Each task gets a fresh Node process.

Cost: spawning a fresh Node process per task takes roughly 300-500ms. For Phase 1 this is acceptable. Phase 6 may revisit with a process pool if it becomes a bottleneck.

# 5. Spawn arguments

```typescript
spawn("node", [
  piCodingAgentRpcEntry,             // path to dist/rpc-entry.js (or dist/cli.js)
  "--mode", "rpc",
  "--provider", taskSession.provider, // e.g. "anthropic", "minimax", "openai"
  "--model",    taskSession.modelId,  // e.g. "claude-sonnet-4-6"
  "--cwd",      taskSession.directory // absolute path, physical isolation
], {
  env: {
    ...process.env,
    ...taskSession.providerEnv,        // injected API key env vars
  },
  stdio: ["pipe", "pipe", "pipe"],
})
```

The `--provider` and `--model` flags are set at spawn time and apply to the entire session. To switch models mid-session, the Adapter sends a `set_model` RPC command rather than restarting the process.

The `--cwd` flag is the directory Pi's file and shell tools operate in. Forge always passes an absolute path under a per-task directory (default `/tmp/forge/<taskId>`). This is the physical isolation boundary. Pi cannot read or write outside this directory unless the user explicitly passes `--no-sandbox` to Pi (Forge never does).

# 6. Wire protocol

## 6.1 Transport

Newline-delimited JSON (NDJSON / JSONL). Each line is one complete JSON document.

```
stdin:  {"id":"1","type":"prompt","message":"hello"}\n
stdout: {"type":"agent_settled","sessionId":"...","messages":[...]}\n
stdout: {"id":"1","type":"response","command":"prompt","success":true}\n
```

Commands go to stdin. Responses and events come on stdout. Stderr is reserved for Pi's own logging and is not part of the protocol.

## 6.2 Commands

Pi's RPC mode accepts a fixed set of commands. Source of truth: `packages/coding-agent/src/modes/rpc/rpc-types.ts`.

| Command | Purpose | Forge uses |
|---|---|---|
| `prompt` | Send a user message | Core execution primitive |
| `steer` | Interrupt a running turn with a new message | Mid-step correction |
| `follow_up` | Queue a message after current turn | Deferred user input |
| `abort` | Cancel the current turn | Task deadline, user cancel |
| `new_session` | Start a fresh session in the same process | Switch context within a process (rarely used) |
| `set_model` | Switch model mid-session | Per-state model selection |
| `get_state` | Read current session state | Recovery after crash |
| `get_messages` | Read conversation history | Phase 2 replay |
| `get_commands` | List available slash commands | Discovery |
| `bash` | Run a shell command directly | Direct verification path (Phase 3+) |

Commands not used by Phase 1: `compact`, `set_auto_compaction`, `set_auto_retry`, `switch_session`, `fork`, `clone`, `export_html`. These are exposed by Pi but Forge has no use for them in Phase 1.

## 6.3 Responses

Each command gets a `RpcResponse`:

```
{"id":"1","type":"response","command":"prompt","success":true}
{"id":"2","type":"response","command":"get_state","success":true,"data":{...}}
{"id":"3","type":"response","command":"prompt","success":false,"error":"model not found"}
```

The `id` field correlates the response to the request. Commands without an `id` get a response without an `id`. Forge always assigns an `id` for correlation.

## 6.4 Events

While a turn runs, Pi emits streaming events on stdout. Source of truth: `packages/coding-agent/src/core/agent-session.ts` and `packages/coding-agent/src/modes/json-event.ts`.

Event types relevant to Phase 1:

| Event | When | Forge uses |
|---|---|---|
| `agent_start` | Turn begins | Lifecycle marker |
| `turn_start` | LLM call begins | UI feed |
| `message_start` | Any message (user/assistant/toolResult) begins | UI feed |
| `message_update` | Assistant message streams in | UI feed |
| `message_end` | Message completes | UI feed |
| `tool_execution_start` | Tool begins | UI feed, security audit |
| `tool_execution_end` | Tool completes | UI feed, security audit |
| `turn_end` | LLM turn completes | Await barrier |
| `agent_settled` | All queued work done | Await barrier (turn_idle equivalent) |
| `error` | Pi internal error | Forge observation failure path |

Events do not carry an `id`. They are not correlated to commands. Forge identifies the current turn by tracking which `prompt` command is in flight.

# 7. Adapter surface

Forge's `AgentRuntime` interface (defined in `src/runtime/interface.ts`) has three operations:

```typescript
interface AgentRuntime {
  createSession(opts: {
    taskId: string;
    directory: string;
    provider: string;
    modelId: string;
    providerEnv: Record<string, string>;
    systemPrompt?: string;
  }): Promise<RuntimeSession>;

  prompt(opts: {
    session: RuntimeSession;
    message: string;
    onEvent?: (e: RuntimeEvent) => void;
    deadlineMs?: number;
  }): Promise<TurnResult>;

  abort(session: RuntimeSession): Promise<void>;
}

interface RuntimeSession {
  readonly id: string;            // Pi session ID
  readonly taskId: string;
  readonly directory: string;
  readonly processPid: number;
}

interface TurnResult {
  readonly success: boolean;
  readonly summary: string;
  readonly messages: readonly RuntimeMessage[];
  readonly usage?: Usage;
}
```

# 8. Mapping Adapter → Pi

| Adapter operation | Pi RPC command(s) | Notes |
|---|---|---|
| `createSession` | spawn Pi subprocess | Send initial `get_state` to confirm boot. Pi auto-creates a session on first prompt. |
| `prompt` | `prompt` | Stream events via `onEvent`. Await `agent_settled` to know turn is done. |
| `abort` | `abort` | Pi stops the current turn at the next tool boundary. |
| shutdown | subprocess `SIGTERM` | Pi's RPC mode installs SIGTERM handler that calls `runtimeHost.dispose()`. |

The `analyze` and `executeTurn` distinction that exists in earlier drafts collapses into `prompt`. The difference between them is:
- `analyze`: caller waits for `agent_settled`, reads final assistant text, throws if no JSON found.
- `executeTurn`: caller waits for `agent_settled`, reads full message list including tool calls and tool results.

Both use the same `prompt` command. The Adapter returns different shapes.

# 9. Error handling

| Pi behavior | Forge response |
|---|---|
| Subprocess exits unexpectedly | Adapter throws `RuntimeSessionCrashed`. Forge marks task `FAILED`. |
| `prompt` response has `success: false` | Adapter throws `PromptRejected(error)`. Forge increments `step.attempts`. |
| `error` event emitted mid-turn | Adapter captures it; next `agent_settled` resolves with `success: false`. |
| Stdin write fails (broken pipe) | Adapter throws. Task ends. |
| Deadline exceeded | Adapter kills subprocess with `SIGKILL`. Throws `DeadlineExceeded`. |

# 10. Subprocess lifecycle in detail

```
adapter.createSession:
  1. resolve piCodingAgentRpcEntry path
  2. build argv and env
  3. spawn childProcess
  4. attachJsonlLineReader on stdout → forward to RPC client
  5. send {"type":"get_state"} → wait for response (boot barrier)
  6. return RuntimeSession

adapter.prompt:
  1. assign id = nextReqId++
  2. serialize {"id", "type":"prompt", "message", ...}
  3. write line to stdin
  4. resolve when stdout emits {"type":"agent_settled", ...}
  5. emit intermediate events via onEvent

adapter.abort:
  1. write {"type":"abort"} to stdin (no id needed)
  2. ignore response (Pi emits abort event but no response)

CLI shutdown:
  1. for each open session: send {"type":"abort"}, then SIGTERM after 1s
  2. after 5s, SIGKILL any survivors
  3. unref all subprocesses
```

# 11. Security boundaries

Three concentric boundaries:

1. **Process boundary**: Pi cannot corrupt Forge state. Pi crashes do not affect Forge.
2. **Working directory**: Pi's file and shell tools are scoped to `--cwd`. They cannot reach `/Users/hcq/forge/pi` or `/Users/hcq/.forge` unless Forge explicitly mounts them.
3. **API key isolation**: API keys live in the spawned subprocess env, not in Forge's process. Forge reads them from `~/.forge/.env` (gitignored) at spawn time and injects them. Forge never persists them and never logs them.

# 12. What Forge does NOT do

- Forge does not import Pi packages. No `node_modules` coupling.
- Forge does not implement file or shell tools. Pi provides them.
- Forge does not maintain a session store. Pi's SessionManager does.
- Forge does not interpret LLM streaming events for tool calls. Forge only cares about `agent_settled` as the terminal signal.
- Forge does not perform compaction or context management. Pi does.

# 13. Phase 1 acceptance criteria

The integration is complete when:

1. `forge run "create hello.txt with hello-forge"` produces `hello.txt` containing `hello-forge`.
2. `TaskSession.state` transitions READY → UNDERSTAND → PLAN → EXECUTE → OBSERVE → COMPLETE.
3. `observations` array contains at least one `PASS` entry from `file_exists` validation.
4. Pi subprocess exits cleanly when Forge CLI exits.
5. No Pi source files in `/Users/hcq/forge/pi` are modified (verifiable via `git status` in the Pi clone).

# 14. Open questions deferred

- Process pool vs per-task process. Phase 1 uses per-task. Phase 6 may pool.
- Multi-turn session reuse across TaskSession states. Phase 1 creates one process per task. Phase 2 may reuse.
- Streaming event backpressure. Phase 1 buffers in memory. Phase 2 may add bounded queue.
- Compaction. Phase 1 lets Pi auto-compact. Phase 3 may surface compaction events to UI.

---

# Appendix A: Verified file references in Pi source

All claims above are grounded in these Pi source files (read 2026-08-22 from local clone at `/Users/hcq/forge/pi`):

- `packages/coding-agent/src/rpc-entry.ts` — 13-line wrapper that injects `--mode rpc`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — 817 lines, full RPC server loop
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` — 289 lines, `RpcCommand` union
- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — 601 lines, reference typed client (Forge does not use this)
- `packages/coding-agent/src/main.ts` — entry point that wires RPC mode
- `packages/ai/src/providers/minimax.ts` — 15 lines, base_url = `https://api.minimaxi.io/anthropic`, env var `MINIMAX_API_KEY`
- `packages/ai/src/providers/anthropic.ts` — 59 lines, base_url = `https://api.anthropic.com`
- `packages/ai/src/api/anthropic-messages.lazy.ts` — 4 lines, lazy import wrapper

# Appendix B: What "model not found" looks like in practice

`minimax.models.ts` imports `data/minimax.json` which is generated by `scripts/generate-models.ts` at build time. If the user clones Pi and runs `npm run build` without first generating model data, the catalog is empty and `minimax/MiniMax-M3` is not in it.

Two consequences:

1. `get_available_models` returns an empty array for `minimax`.
2. `set_model` with any minimax model returns `Model not found: minimax/<id>`.

This is a Pi build-state issue, not a Forge issue. Forge surfaces the error from Pi unchanged.

Workaround: run `npm run generate-models` in the Pi clone before using Pi. This fetches live model catalogs from provider APIs and requires network access.
