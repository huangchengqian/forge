# Model Configuration Specification

> Status: Phase 1 implementation spec
> Source of truth: actual `https://github.com/earendil-works/pi.git` (commit `c49906ec7` on `main`)
> Related: `DESIGN.md` §3, `docs/09-PI-RUNTIME-INTEGRATION.md`

---

# 1. Purpose

This document defines how Forge selects which LLM provider and model to use.

Forge does not implement LLM providers. Forge does not hardcode provider URLs or model catalogs. Forge passes the user's choice to Pi at spawn time and Pi handles the rest.

The reason: there are 30+ LLM providers in active use. Each has its own auth flow, model catalog, streaming format, and quirks. Reimplementing this in Forge would duplicate thousands of lines of code that Pi already maintains. Worse, every provider change would require a Forge release.

Forge's only job is to:

1. Hold a model selection (provider + model id) per TaskSession.
2. Resolve API keys from the user's environment.
3. Pass both to Pi's spawn arguments.

# 2. Model selection string

Format: `<provider>/<model-id>`

Examples:

- `anthropic/claude-sonnet-4-6`
- `minimax/MiniMax-M3`
- `openai/gpt-5`
- `openrouter/anthropic/claude-3.5-sonnet`
- `ollama/llama3.1-70b`

The `<provider>` segment must match a provider id Pi recognizes. The `<model-id>` must match a model id within that provider's catalog.

Pi's provider list lives in `packages/ai/src/providers/` (30+ entries as of `c49906ec7`). The full list:

```
amazon-bedrock, ant-ling, anthropic, azure-openai-responses, baseten,
cerebras, cloudflare-ai-gateway, cloudflare-workers-ai, deepseek, faux,
fireworks, github-copilot, google, google-vertex, groq, huggingface,
kimi-coding, minimax, minimax-cn, mistral, moonshotai, moonshotai-cn,
nvidia, openai, openai-codex, opencode, opencode-go, openrouter,
qwen-token-plan, qwen-token-plan-cn, qwen-token-plan-individual, together,
vercel-ai-gateway, xai, xiaomi, xiaomi-token-plan-ams, xiaomi-token-plan-cn,
xiaomi-token-plan-sgp, zai-coding, zai-coding-cn
```

Plus "any OpenAI-compatible API" via Ollama, vLLM, LM Studio, etc. — these are configured at runtime through Pi's provider config and do not have a fixed provider id.

# 3. Where the selection lives

Three places, in priority order:

## 3.1 CLI flag (highest priority)

```
forge run "implement X" --model anthropic/claude-sonnet-4-6
forge run "implement X" -m minimax/MiniMax-M3
```

Applies to this invocation only. Does not persist.

## 3.2 Forge config file

`~/.forge/config.yaml`:

```yaml
models:
  default: "anthropic/claude-sonnet-4-6"

  # Per-state model selection. Optional. Falls back to `default`.
  perState:
    understand: "minimax/MiniMax-M3"      # small/cheap model for repo analysis
    plan: "minimax/MiniMax-M3"
    execute: "anthropic/claude-sonnet-4-6" # big model for code execution
    observe: "minimax/MiniMax-M3"        # small/cheap for verification reasoning
```

Per-state selection lets the user mix models: a cheap model for UNDERSTAND (just summarize the repo) and a strong model for EXECUTE (actually write code). This is a deliberate Phase 2+ feature. Phase 1 always uses `default` for all states.

## 3.3 Hardcoded fallback

If neither CLI flag nor config file is set, Forge uses:

```
anthropic/claude-sonnet-4-6
```

This is a placeholder. Phase 1 requires the user to either pass `--model` or set `models.default` in config.

# 4. Resolution algorithm

When Forge starts a TaskSession, model resolution is:

```
1. If --model CLI flag is set: use it.
2. Else if TaskSession.state has a perState override in config: use it.
3. Else if config has models.default: use it.
4. Else: use hardcoded fallback (anthropic/claude-sonnet-4-6).
5. Validate: provider must exist in Pi's catalog, model id must exist for that provider.
   On failure: emit ConfigError, do not spawn Pi.
```

The split between step 5 and Pi boot is intentional. Forge pre-validates the model string using a static list (cached at startup, refreshed on `--refresh-models`). This avoids spawning a Pi subprocess just to discover the model is unknown.

# 5. API key resolution

API keys are environment variables. Forge reads them at spawn time and injects into the Pi subprocess env.

Resolution per provider:

| Provider | Env var(s) |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| `openai` | `OPENAI_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `minimax-cn` | `MINIMAX_CN_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` |
| `bedrock` | ambient AWS credentials |
| `vertex` | `GOOGLE_CLOUD_API_KEY` or ADC |
| ... | (Pi source of truth: `packages/ai/src/env-api-keys.ts`) |

Resolution chain for a given key:

```
1. Explicit override in TaskSession.metadata.apiKeys (e.g. CLI flag --api-key)
2. Process env (already set when Forge CLI launched)
3. ~/.forge/.env (file loaded into process env at startup)
4. ~/.pi/auth.json (Pi's own credential store, loaded by Pi at startup)
5. None found: spawn Pi anyway and let Pi report auth failure
```

Step 5 is intentional. Pi reports auth errors in a structured way (see `ModelsError`). Forge surfaces these to the user verbatim. This avoids duplicating Pi's auth resolution logic.

# 6. Storage

## 6.1 `~/.forge/config.yaml` (user-editable, gitignored)

```yaml
# Forge configuration
models:
  default: "anthropic/claude-sonnet-4-6"
  perState:
    understand: "minimax/MiniMax-M3"
    execute: "anthropic/claude-sonnet-4-6"
```

This file is plain YAML. Forge parses it with a strict schema. Unknown keys are an error (catches typos).

## 6.2 `~/.forge/.env` (user-editable, gitignored, mode 0600)

```
MINIMAX_API_KEY=sk-cp-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

This file follows dotenv syntax. Forge loads it with `dotenv` at startup. The file must have permissions `0600`; Forge warns if it does not.

## 6.3 `~/.pi/auth.json` (Pi's own store, owned by Pi)

Pi maintains this file when the user runs `pi login` or when OAuth flows complete. Forge does not read or write this file. Pi reads it directly.

# 7. What the Adapter actually receives

After resolution, the Adapter gets a `TaskSession` with:

```typescript
{
  taskId: "task_20260822_001",
  goal: "implement OAuth",
  state: "READY",
  directory: "/tmp/forge/task_20260822_001",
  plan: null,
  observations: [],
  model: {
    provider: "anthropic",          // resolved from "anthropic/claude-sonnet-4-6"
    modelId: "claude-sonnet-4-6",
  },
  // Resolved at spawn time, not persisted to TaskSession JSON:
  spawnEnv: {
    ANTHROPIC_API_KEY: "sk-ant-...", // from process env or .env
  },
}
```

The Adapter spawns:

```
node <pi-rpc-entry> --mode rpc \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --cwd /tmp/forge/task_20260822_001
```

with `env: { ...process.env, ...taskSession.spawnEnv }`.

# 8. Mid-session model switching

Phase 1 always uses one model per TaskSession. The Orchestrator selects the model when the task starts and does not change it.

Phase 2 introduces per-state switching (UNDERSTAND uses a cheap model, EXECUTE uses a strong one). Implementation: the Orchestrator sends `{"type":"set_model","provider":"X","modelId":"Y"}` between phases.

Phase 3+ may add `set_model` mid-EXECUTE for adaptive cost control.

# 9. Validation

Forge pre-validates the model string before spawning Pi. Two checks:

1. Provider is in Pi's known list (`packages/ai/src/providers/` directory names).
2. Model id is in that provider's catalog (cached from Pi at Forge startup).

If either fails:

```
$ forge run "..." --model anthropic/claude-99-nonexistent
error: model not found: anthropic/claude-99-nonexistent
  available models for anthropic:
    - claude-sonnet-4-6
    - claude-opus-4-6
    - ...
hint: run `forge refresh-models` to update the catalog
```

The catalog cache is stored at `~/.forge/models-cache.json`. Refresh by either:

- `forge refresh-models` command (Forge calls Pi to enumerate providers + models)
- Or the cache auto-refreshes on startup if it is older than 24 hours

# 10. Phase 1 scope

Phase 1 implements:

- Single model per task (no per-state switching yet)
- `--model` CLI flag
- `~/.forge/config.yaml` with `models.default` only (no `perState`)
- `~/.forge/.env` for API keys
- Pre-spawn model validation against a baked-in provider list
- No catalog cache, no auto-refresh — hardcoded provider list only

Phase 1 explicitly does NOT implement:

- Per-state model selection
- Model catalog cache
- `forge refresh-models` command
- Mid-session `set_model`
- OAuth flows (only API keys)
- Custom provider registration

# 11. Security

- API keys are loaded at startup and held in process memory only. Never written to logs, never written to TaskSession JSON, never written to events.
- `~/.forge/.env` must be `0600`. Forge warns if it is not and refuses to start if it is world-readable.
- The model string itself (e.g. `minimax/MiniMax-M3`) is logged but the API key is not.
- Pi subprocess stderr is captured for debugging but stripped of known API key patterns before display.
- When Forge CLI exits, the spawned Pi subprocesses are killed (SIGTERM, then SIGKILL after 5s). This ensures API keys do not linger in Pi subprocess memory after Forge exits.

# 12. Failure modes and error messages

| Failure | Error message |
|---|---|
| No model configured | `no model configured: pass --model <provider>/<id> or set models.default in ~/.forge/config.yaml` |
| Unknown provider | `unknown provider: <X>. run 'forge refresh-models' to update the catalog.` |
| Unknown model for provider | `model not found: <X>/<Y>. available models: ...` |
| Missing API key env var | `missing API key: set <ENV_VAR> in environment or ~/.forge/.env` |
| Pi fails to auth at boot | passthrough of Pi's error message |
| Pi returns `model not found` at runtime | `pi: model not found: <X>/<Y> (catalog may be stale; run 'pi --list-models')` |

All errors exit with code 1 and print to stderr.

# 13. Examples

## 13.1 Minimal invocation

```
# User has ~/.forge/.env with MINIMAX_API_KEY set
forge run "create hello.txt with hello-forge"
# Uses default model from config or fallback (anthropic/claude-sonnet-4-6)
# If that provider's key is not set, errors out with clear message
```

## 13.2 Explicit model

```
forge run "create hello.txt" --model minimax/MiniMax-M3
# MINIMAX_API_KEY must be in env or ~/.forge/.env
```

## 13.3 Config with default

`~/.forge/config.yaml`:
```yaml
models:
  default: "minimax/MiniMax-M3"
```

`~/.forge/.env`:
```
MINIMAX_API_KEY=sk-cp-...
```

```
forge run "create hello.txt"
# Uses minimax/MiniMax-M3 with key from .env
```

## 13.4 Per-state (Phase 2+, not Phase 1)

```yaml
models:
  default: "anthropic/claude-sonnet-4-6"
  perState:
    understand: "minimax/MiniMax-M3"
    plan: "minimax/MiniMax-M3"
    execute: "anthropic/claude-sonnet-4-6"
```

# 14. Rationale: why this is the simplest viable design

Three constraints shaped this design:

1. **Forge does not implement providers.** Every model catalog line and every API key resolution rule would be duplicated. The design pushes all provider knowledge into Pi where it already lives.

2. **Forge does not persist API keys.** The user is responsible for their own key storage. Forge reads from env, injects into Pi subprocess env, and forgets. No key store to secure, no key rotation to coordinate.

3. **Phase 1 is hello-world only.** The design supports `forge run "<one goal>" --model <one model>` and nothing else. Per-state, mid-session switching, and catalog cache are all deferred. This keeps Phase 1 to roughly 100 lines of model-resolution code.

The cost is that the user must know which env var each provider needs. This is documented in section 5 and will be expanded in `forge --help` output.

# 15. Open questions deferred

- Catalog cache TTL and refresh policy. (Phase 3+.)
- `forge login` command that wraps `pi login`. (Phase 4+.)
- Per-task model override (different from per-state). (Phase 3+.)
- Model cost budget per task. (Phase 4+.)
