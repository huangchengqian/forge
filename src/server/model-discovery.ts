/**
 * Model discovery (Phase: model auto-discovery, PM decision 2026-09-10).
 *
 * Multi-subscription config made hand-typing a `modelId` the biggest source
 * of setup friction. This module asks the subscription's own endpoint what
 * models it serves — the same list the provider's console shows — so the
 * Settings page can offer a picker instead of a guess.
 *
 * Key handling: the apiKey stays server-side. The desktop posts the endpoint
 * triple to `POST /providers/models`; nothing is persisted and the key is
 * never echoed back.
 */
import type { ProviderApi } from "./config-store.ts";

export interface ProviderEndpoint {
  api: ProviderApi;
  baseUrl: string;
  apiKey: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Build the endpoint's model-list URL. OpenAI-compatible gateways hang
 * `/models` under the version segment (`…/v1/models`); Anthropic-compatible
 * endpoints expose `/v1/models` at the origin. A baseUrl that already ends
 * in a version segment is used as-is.
 */
export function modelsEndpoint(sub: ProviderEndpoint): string {
  const base = sub.baseUrl.replace(/\/+$/, "");
  const hasVersion = /\/v\d+$/.test(base);
  const url = hasVersion ? `${base}/models` : `${base}/v1/models`;
  // Anthropic paginates (default 20); ask for the full page in one shot.
  return sub.api === "anthropic-messages" ? `${url}?limit=1000` : url;
}

function headersFor(sub: ProviderEndpoint): Record<string, string> {
  if (sub.api === "anthropic-messages") {
    return { "x-api-key": sub.apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${sub.apiKey}` };
}

/** Both OpenAI and Anthropic answer `{ data: [{ id }, …] }`. */
export function parseModelsResponse(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

/** Fetch the model ids a subscription's endpoint offers. Throws on HTTP/network errors. */
export async function discoverModels(sub: ProviderEndpoint): Promise<string[]> {
  const res = await fetch(modelsEndpoint(sub), {
    headers: headersFor(sub),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`model discovery failed: HTTP ${res.status} from ${modelsEndpoint(sub)}`);
  }
  return parseModelsResponse(await res.json());
}
