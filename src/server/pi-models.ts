/**
 * Pi custom-model integration (openai-compatible providers).
 *
 * Pi does not know a provider named "openai-compatible". Custom endpoints are
 * declared in Pi's models.json (`<agentDir>/models.json`), keyed by a Forge
 * stable name, with the wire protocol chosen via `api`:
 *   "anthropic-messages" | "openai-completions" | "openai-responses"
 * (verified against pi-ai compat registry + provider-composer).
 *
 * Forge points Pi at its own agent dir via PI_CODING_AGENT_DIR so the user's
 * ~/.pi/agent/ is never touched, and spawns with `--provider custom`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderConfig } from "./config-store.ts";

/** Forge's stable provider name for a custom endpoint. */
export const CUSTOM_PROVIDER_NAME = "custom";

export function piAgentDir(forgeHome: string): string {
  return join(forgeHome, "pi-agent");
}

/**
 * Write (or refresh) the custom provider entry into Forge's pi-agent
 * models.json. No-op for built-in providers. Returns the provider name to
 * pass to Pi via --provider.
 */
export async function syncCustomModels(forgeHome: string, provider: ProviderConfig): Promise<string> {
  if (provider.kind !== "openai-compatible") return provider.kind;

  const dir = piAgentDir(forgeHome);
  const modelsJson = {
    providers: {
      [CUSTOM_PROVIDER_NAME]: {
        api: provider.api ?? "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        models: [{ id: provider.modelId }],
      },
    },
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2) + "\n", "utf8");
  return CUSTOM_PROVIDER_NAME;
}
