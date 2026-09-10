import {
  streamSimple,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { ProviderConfig } from "./config-store.ts";

/**
 * Look up a model in Pi's built-in catalog by id (protocol as a tiebreaker
 * when several providers ship the same model id). Returns real pricing,
 * context window, and reasoning flag — without this, CostGuard sees zero
 * cost on every real provider and the budget guard is decorative.
 */
function lookupBuiltinModel(modelId: string, api?: string): Model<any> | null {
  for (const provider of getProviders()) {
    for (const model of getModels(provider as never) as unknown as Model<any>[]) {
      if (model.id !== modelId) continue;
      if (api && model.api === api) return model;
      if (!api) return model;
    }
  }
  // Second pass: same model id under a different protocol still has valid
  // pricing (e.g. an openai-completions id served over anthropic-messages).
  for (const provider of getProviders()) {
    for (const model of getModels(provider as never) as unknown as Model<any>[]) {
      if (model.id === modelId) return model;
    }
  }
  return null;
}

/**
 * Build a pi-ai Model object from a Forge subscription. The subscription's
 * apiKey is NOT part of the Model — it rides on the stream options (see
 * makeStreamFnWithKey) so keys never land in persisted session data.
 */
export function buildModel(subscription: ProviderConfig): Model<any> {
  const catalog = lookupBuiltinModel(subscription.modelId, subscription.api);
  if (!catalog) {
    console.warn(
      `[forge] model "${subscription.modelId}" not in Pi catalog — cost guard will see $0 (pricing unknown)`,
    );
  }
  // Start from the catalog entry when there is one, then override the
  // identity fields with the subscription's. Rebuilding the object from
  // scratch (the previous shape) silently dropped `thinkingLevelMap` and
  // `compat` — the very fields the adapters read to translate a thinking
  // level into the provider's own effort values.
  return {
    ...(catalog ?? {}),
    id: subscription.modelId,
    name: catalog?.name ?? subscription.modelId,
    api: subscription.api,
    provider: subscription.id,
    baseUrl: subscription.baseUrl,
    reasoning: catalog?.reasoning ?? /claude|gpt-5|deepseek|o[1345]/i.test(subscription.modelId),
    input: catalog?.input ?? ["text"],
    cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: catalog?.contextWindow ?? 128_000,
    maxTokens: catalog?.maxTokens ?? 8_192,
  } as unknown as Model<any>;
}

/**
 * Thinking levels this subscription's model actually supports, in Pi's own
 * order. A non-reasoning model yields `["off"]`, and levels marked
 * unsupported in the model's `thinkingLevelMap` are filtered out — so the UI
 * can offer only levels that will do something, instead of a control that
 * silently no-ops.
 */
export function modelThinkingLevels(subscription: ProviderConfig): string[] {
  try {
    return getSupportedThinkingLevels(buildModel(subscription) as never) as string[];
  } catch {
    return ["off"];
  }
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
