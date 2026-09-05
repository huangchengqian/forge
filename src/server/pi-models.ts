/**
 * Pi custom-model integration (every configured subscription).
 *
 * Pi does not know Forge's configured endpoints. Each Forge subscription is
 * declared as its own provider entry in Pi's models.json
 * (`<agentDir>/models.json`), keyed by the subscription id, with the wire
 * protocol chosen via `api`:
 *   "anthropic-messages" | "openai-completions" | "openai-responses"
 * (verified against pi-ai compat registry + provider-composer).
 *
 * Declaring ALL subscriptions (not just the active one) lets a running Pi
 * session switch models mid-flight via `set_model` across different vendors,
 * base URLs, and protocols — no session rebuild.
 *
 * Forge points Pi at its own agent dir via PI_CODING_AGENT_DIR so the user's
 * ~/.pi/agent/ is never touched, and spawns with `--provider <subscription id>`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderConfig } from "./config-store.ts";

export function piAgentDir(forgeHome: string): string {
  return join(forgeHome, "pi-agent");
}

/** The Pi provider name for a subscription (stable, = the subscription id). */
export function providerName(subscription: ProviderConfig): string {
  return subscription.id;
}

/**
 * Write every subscription into Forge's pi-agent models.json, one provider
 * entry each (keyed by subscription id). Called before spawning and again
 * before a switch so the running session's model snapshot stays in sync.
 */
export async function syncCustomModels(forgeHome: string, providers: readonly ProviderConfig[]): Promise<void> {
  const dir = piAgentDir(forgeHome);
  const entries: Record<string, unknown> = {};
  for (const p of providers) {
    entries[p.id] = {
      api: p.api,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      models: [{ id: p.modelId }],
    };
  }
  const modelsJson = { providers: entries };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2) + "\n", "utf8");
}
