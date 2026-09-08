import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { ProviderConfig } from "./config-store.ts";

/**
 * Build a pi-ai Model object from a Forge subscription. The subscription's
 * apiKey is NOT part of the Model — it rides on the stream options (see
 * makeStreamFnWithKey) so keys never land in persisted session data.
 */
export function buildModel(subscription: ProviderConfig): Model<any> {
  return {
    id: subscription.modelId,
    name: subscription.modelId,
    api: subscription.api,
    provider: subscription.id,
    baseUrl: subscription.baseUrl,
    reasoning: /claude|gpt-5|deepseek|o[1345]/i.test(subscription.modelId),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<any>;
}

/** Canonical env key per protocol, seeded for any env-consulting code path. */
export function providerEnv(subscription: ProviderConfig): Record<string, string> {
  switch (subscription.api) {
    case "anthropic-messages":
      return { ANTHROPIC_API_KEY: subscription.apiKey };
    default:
      return { OPENAI_API_KEY: subscription.apiKey };
  }
}

/**
 * Wrap Pi's default simple-stream with the subscription's API key on every
 * request (StreamOptions.apiKey takes precedence over env lookup).
 */
export function makeStreamFnWithKey(
  apiKey: string,
  env: Record<string, string>,
): Parameters<typeof agentLoop>[4] {
  for (const [k, v] of Object.entries(env)) {
    if (v && !process.env[k]) process.env[k] = v;
  }
  return ((model: Model<any>, context: never, options?: { apiKey?: string }) =>
    streamSimple(model as never, context, {
      ...options,
      apiKey,
    })) as unknown as Parameters<typeof agentLoop>[4];
}
