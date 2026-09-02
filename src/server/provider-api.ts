import https from "node:https";

/**
 * Minimal server-side provider HTTP client shared by provider readiness
 * checks (provider-check.ts) and the Phase 9.7 Intent Router's mini
 * completion. Deliberately tiny: two wire protocols, no streaming, no
 * tooling. Keeps the Intent Router decoupled from PiRuntime.
 */

export type ProviderEndpoint = {
  kind: string;
  apiKey: string;
  modelId: string;
  baseUrl: string;
  /** Wire protocol; "anthropic-messages" (default) or "openai-completions"/"openai-responses". */
  api?: string;
};

export type ProviderResponse = {
  status: number;
  body: Record<string, unknown>;
};

export function isOpenAIProtocol(api: string | undefined): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

export async function callProvider(
  endpoint: ProviderEndpoint,
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<ProviderResponse> {
  const url = new URL(endpoint.baseUrl);
  const openai = isOpenAIProtocol(endpoint.api);
  const apiPath = openai
    ? url.pathname.replace(/\/$/, "") + "/chat/completions"
    : url.pathname.replace(/\/$/, "") + "/v1/messages";

  return new Promise((resolveP, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (openai) {
      headers.authorization = `Bearer ${endpoint.apiKey}`;
    } else {
      headers["x-api-key"] = endpoint.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 443,
        path: apiPath,
        method: "POST",
        headers,
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString("utf8")));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            resolveP({ status: res.statusCode ?? 500, body: JSON.parse(buf) });
          } catch {
            resolveP({ status: res.statusCode ?? 500, body: { raw: buf.slice(0, 500) } });
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Extract the assistant's text payload for either wire protocol. */
export function extractResponseText(res: ProviderResponse, api: string | undefined): string {
  if (isOpenAIProtocol(api)) {
    const choices = (res.body as { choices?: Array<{ message?: { content?: string } }> }).choices;
    const content = choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
  const content = (res.body as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
