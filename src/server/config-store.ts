import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The wire protocol is the primary axis of provider configuration. It
 * determines how the runtime talks to the endpoint (Anthropic messages,
 * OpenAI chat/completions, OpenAI responses). Vendors are just presets that
 * pin a baseUrl (and a suggested model) to one of these protocols — they are
 * NOT a separate type axis. `kind` previously conflated the two (mixing
 * "minimax"/"anthropic" — both anthropic-messages vendors — with the
 * "openai-compatible" access mode), which is exactly what this removes.
 */
export type ProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export const PROVIDER_APIS: readonly ProviderApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

/**
 * One configured model subscription. Users typically hold several — a cheap
 * model for routine work and a strong one for hard tasks, across multiple
 * vendors — so Forge stores a list, not a single provider.
 */
export type ProviderConfig = {
  /** Stable identifier used to reference this subscription from tasks. */
  id: string;
  api: ProviderApi;
  apiKey: string;
  modelId: string;
  baseUrl: string;
};

/** A vendor preset: pins a protocol to a baseUrl + suggested model. */
export type ProviderPreset = {
  id: string;
  label: string;
  api: ProviderApi;
  baseUrl: string;
  defaultModel: string;
};

/**
 * Known vendor presets, grouped by protocol. Model ids and base URLs are
 * taken from Pi's provider model tables (packages/ai/src/providers/data).
 * Google and other non-standard protocols are intentionally omitted: Forge's
 * custom path supports only the three protocols above.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "anthropic", label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
  { id: "minimax", label: "MiniMax", api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic", defaultModel: "MiniMax-M3" },
  { id: "minimax-cn", label: "MiniMax (国内)", api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic", defaultModel: "MiniMax-M3" },
  { id: "kimi-coding", label: "Kimi (coding)", api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding", defaultModel: "kimi-for-coding" },
  { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5" },
  { id: "deepseek", label: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro" },
  { id: "moonshotai", label: "Moonshot (Kimi)", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-k2.5" },
  { id: "groq", label: "Groq", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
];

export type ForgeConfig = {
  version: 2;
  providers: ProviderConfig[];
  defaultProviderId: string | null;
  maxConcurrency: number;
};

const DEFAULT_CONFIG: ForgeConfig = {
  version: 2,
  providers: [],
  defaultProviderId: null,
  maxConcurrency: 2,
};

export function newProviderId(): string {
  return randomUUID();
}

export function configPath(forgeHome: string): string {
  return resolve(join(forgeHome, "forge-config.json"));
}

/**
 * Resolve the subscription to use. Explicit providerId wins; otherwise the
 * configured default; otherwise the first entry; otherwise null (unconfigured
 * headless path).
 */
export function resolveProvider(
  cfg: ForgeConfig,
  providerId?: string,
): ProviderConfig | null {
  const byId = (id: string | null | undefined) =>
    cfg.providers.find((p) => p.id === id) ?? null;
  return byId(providerId) ?? byId(cfg.defaultProviderId) ?? (cfg.providers[0] ?? null);
}

export async function loadForgeConfig(forgeHome: string): Promise<ForgeConfig> {
  try {
    const raw = await readFile(configPath(forgeHome), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    const maxConcurrency = typeof parsed.maxConcurrency === "number" ? parsed.maxConcurrency : 2;

    // v2: `providers[]`. Validate each entry; drop malformed ones.
    if (Array.isArray(parsed.providers)) {
      const providers = (parsed.providers as unknown[])
        .map((p) => validateProvider(p))
        .filter((p): p is ProviderConfig => p !== null);
      const defaultId = typeof parsed.defaultProviderId === "string" ? parsed.defaultProviderId : null;
      return {
        version: 2,
        providers,
        defaultProviderId: providers.some((p) => p.id === defaultId) ? defaultId : (providers[0]?.id ?? null),
        maxConcurrency,
      };
    }

    // v1: single `provider`. Migrate to a one-entry list.
    const legacy = coerceProvider(parsed.provider);
    const providers = legacy ? [legacy] : [];
    return {
      version: 2,
      providers,
      defaultProviderId: legacy?.id ?? null,
      maxConcurrency,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

export async function saveForgeConfig(forgeHome: string, config: ForgeConfig): Promise<void> {
  const p = configPath(forgeHome);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  await rename(tmp, p);
}

export async function isConfigured(forgeHome: string): Promise<boolean> {
  const cfg = await loadForgeConfig(forgeHome);
  return cfg.providers.some((p) => p.apiKey.length > 0);
}

export function validateProvider(p: unknown): ProviderConfig | null {
  if (!p || typeof p !== "object") return null;
  const obj = p as Record<string, unknown>;
  const api = obj.api as ProviderApi;
  if (!PROVIDER_APIS.includes(api)) return null;
  if (typeof obj.apiKey !== "string" || !obj.apiKey.trim()) return null;
  if (typeof obj.modelId !== "string" || !obj.modelId.trim()) return null;
  if (typeof obj.baseUrl !== "string" || !obj.baseUrl.trim()) return null;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : newProviderId();
  return { id, api, apiKey: obj.apiKey, modelId: obj.modelId, baseUrl: obj.baseUrl };
}

/**
 * Coerce a persisted v1 provider into the current shape. The pre-protocol
 * format used a `kind` axis ("minimax" | "anthropic" | "openai-compatible")
 * with an optional `api`. Both "anthropic" and "minimax" are
 * anthropic-messages vendors, and "openai-compatible" carried the protocol
 * in `api` (defaulting to openai-completions). This migration is applied on
 * read so existing forge-config.json files keep working.
 */
function coerceProvider(raw: unknown): ProviderConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  // New shape already.
  if (typeof obj.api === "string" && !("kind" in obj)) {
    return validateProvider(obj);
  }
  // Legacy shape: translate `kind` into an explicit protocol.
  const kind = obj.kind as string | undefined;
  if (kind === "anthropic" || kind === "minimax" || kind === "openai-compatible") {
    const api: ProviderApi =
      kind === "openai-compatible"
        ? ((obj.api as ProviderApi) ?? "openai-completions")
        : "anthropic-messages";
    return validateProvider({
      api,
      apiKey: obj.apiKey,
      modelId: obj.modelId,
      baseUrl: obj.baseUrl,
    });
  }
  return null;
}
