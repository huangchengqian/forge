import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ProviderKind = "minimax" | "anthropic" | "openai-compatible";

/** Wire protocol for custom (openai-compatible) providers; Pi api registry keys. */
export type ProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export const PROVIDER_APIS: readonly ProviderApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

export type ProviderConfig = {
  kind: ProviderKind;
  apiKey: string;
  modelId: string;
  baseUrl: string;
  /** Protocol used when kind = "openai-compatible"; default "openai-completions". */
  api?: ProviderApi;
};

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
      provider: parsed.provider ?? null,
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
  const kind = obj.kind as ProviderKind;
  if (!["minimax", "anthropic", "openai-compatible"].includes(kind)) return null;
  if (typeof obj.apiKey !== "string" || !obj.apiKey.trim()) return null;
  if (typeof obj.modelId !== "string" || !obj.modelId.trim()) return null;
  if (typeof obj.baseUrl !== "string" || !obj.baseUrl.trim()) return null;
  const api = obj.api as ProviderApi | undefined;
  if (api !== undefined && !PROVIDER_APIS.includes(api)) return null;
  const result: ProviderConfig = { kind, apiKey: obj.apiKey, modelId: obj.modelId, baseUrl: obj.baseUrl };
  if (api !== undefined) result.api = api;
  return result;
}
