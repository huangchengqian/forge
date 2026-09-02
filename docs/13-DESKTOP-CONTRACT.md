# Forge Desktop Contract — Protocol & API v1

> Status: FROZEN for Desktop Alpha (Phase 8.0). Changes require an amendment per docs/11 §7.
> Implementations: `src/server/` (auth.ts, event-stream.ts, projects.ts, http-server.ts, task-manager.ts).
> Consumers: Tauri shell + webview UI (docs/12).

---

# 1. Transport & Authentication

- Base URL: `http://127.0.0.1:<port>` (loopback only).
- Handshake file: `<FORGE_HOME>/server.json`, written at listen, mode 0600, removed on graceful close:

```json
{
  "protocolVersion": 1,
  "port": 5300,
  "host": "127.0.0.1",
  "token": "<base64url-256bit>",
  "pid": 12345,
  "startedAt": 1787489817032
}
```

- Auth: every request except `GET /health` requires the token via
  `Authorization: Bearer <token>` header **or** `?token=<token>` query
  (query form exists because `EventSource` cannot set headers).
- Failure: `401 {"error":"unauthorized"}`.
- All responses carry header `x-forge-protocol: 1`.
- `/health` is open and returns `{ok:true, protocolVersion:1}`.

# 2. Event Protocol v1

Envelope (frozen — fields may be added, never removed or renamed):

```json
{ "seq": 7, "timestamp": 1787489950000, "type": "STATE_CHANGED",
  "payload": { "from": "EXECUTE", "to": "OBSERVE" } }
```

- `seq`: 1-based line number in the task's append-only JSONL log.
  Stable across reconnects and process restarts → clients dedupe replay/live
  overlap by seq; gaps are possible (transient events are not persisted),
  duplicates are impossible.
- `type`: persisted lifecycle event (`TASK_CREATED`, `STATE_CHANGED`,
  `STEP_STARTED`, `OBSERVATION_CREATED`, `FIX_STARTED`, `PLAN_CREATED`,
  `STEP_ADDED`*, `STEP_UPDATED`*, `PLAN_REVISED`, `EVALUATION_STARTED`,
  `EVALUATION_COMPLETED`, `TASK_COMPLETED`, `TASK_FAILED`). (* reserved)
- Delivery: SSE, one JSON envelope per `data:` frame, heartbeat comment every
  15s. Replay = full history first, then live tail of appends.

Endpoint: `GET /tasks/:id/stream?token=...`

The legacy bus-based `GET /tasks/:id/events` remains for the pre-desktop web
UI but is NOT part of this contract.

# 3. API Table

| Method | Path | In | Out | Errors |
|---|---|---|---|---|
| GET | /health | – | `{ok, protocolVersion}` | – |
| POST | /tasks | `{goal, provider?, modelId?, maxConcurrency?}` | 202 `{taskId,state}` | 400 |
| GET | /tasks | – | `{tasks: TaskSession[]}` | – |
| GET | /tasks/:id | – | TaskSession | 404 |
| GET | /tasks/:id/stream | token query | SSE envelopes (§2) | 404 |
| GET | /tasks/:id/events | token query | legacy SSE (non-contract) | 404 |
| POST | /tasks/:id/cancel | – | 202 `{cancelled,message}` / 409 | – |
| POST | /tasks/:id/resume | – | 202 `{resumed,message}` / 409 | – |
| POST | /projects | `{path(abs), name?}` | 201 ProjectRecord | 400 |
| GET | /projects | – | `{projects[], activeProjectId}` | – |
| POST | /projects/:id/select | – | ProjectRecord | 404 |
| GET | /projects/active | – | `{project\|null}` | – |
| GET | /memory | `?type=` | `{items[]}` | – |
| GET | /memory/search | `?q=&types=a,b&max=&min=` | `{results:[{item,score,matchedKeywords}]}` | – |
| POST | /memory | `{type,content,source?,confidence?,keywords?,taskRefs?}` | 201 MemoryItem | 400 |

Defaults on POST /memory: `source=USER`, `confidence=1`; keywords auto-derived
from content when omitted.

TaskSession shape: docs/01 + Phase 5.3 (`currentStepId`, `runtime`,
`lastEvaluation`). MemoryItem: Phase 3. ProjectRecord:

```json
{ "id":"prj_x", "name":"my-app", "path":"/abs/dir",
  "createdAt":0, "lastOpenedAt":0 }
```

Storage: `~/.forge/projects.json` (server-owned; register re-selects existing
path idempotently; select bumps lastOpenedAt).

# 4. Non-Goals (v1 contract)

- No multi-user/auth beyond loopback token.
- No remote transport (no TLS/host binding).
- No memory delete/edit (A-7).
- No tool-level permission enforcement (A-3).
- Legacy `/events` semantics unchanged but unsupported for desktop clients.

# 5. Tauri Integration Notes

1. Shell spawns sidecar `forge-serve --port 0`; reads handshake file
   (poll ≤5s) for port+token; injects into webview bootstrap config.
2. Keychain-stored provider keys are injected as env vars into the sidecar
   spawn only — never through HTTP, never persisted by Forge.
3. On sidecar death: relaunch; new sidecar performs recovery sweep
   (`listTasks` → auto-resume non-terminal, opt-in flag) — proven flow.
4. EventSource consumers use `?token=`; fetch consumers prefer header.
