import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

export type ProviderConfig = {
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
  version: 1;
  provider: ProviderConfig | null;
  maxConcurrency: number;
};

const DEFAULT_CONFIG: ForgeConfig = {
  version: 1,
  provider: null,
  maxConcurrency: 2,
};

export function configPath(forgeHome: string): string {
  return resolve(join(forgeHome, "forge-config.json"));
}

export async function loadForgeConfig(forgeHome: string): Promise<ForgeConfig> {
  try {
    const raw = await readFile(configPath(forgeHome), "utf8");
    const parsed = JSON.parse(raw) as Partial<ForgeConfig>;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    return {
      version: 1,
      provider: coerceProvider(parsed.provider),
      maxConcurrency: typeof parsed.maxConcurrency === "number" ? parsed.maxConcurrency : 2,
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
  return cfg.provider !== null && cfg.provider.apiKey.length > 0;
}

export function validateProvider(p: unknown): ProviderConfig | null {
  if (!p || typeof p !== "object") return null;
  const obj = p as Record<string, unknown>;
  const api = obj.api as ProviderApi;
  if (!PROVIDER_APIS.includes(api)) return null;
  if (typeof obj.apiKey !== "string" || !obj.apiKey.trim()) return null;
  if (typeof obj.modelId !== "string" || !obj.modelId.trim()) return null;
  if (typeof obj.baseUrl !== "string" || !obj.baseUrl.trim()) return null;
  return { api, apiKey: obj.apiKey, modelId: obj.modelId, baseUrl: obj.baseUrl };
}

/**
 * Coerce a persisted provider into the current shape. The pre-protocol
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
