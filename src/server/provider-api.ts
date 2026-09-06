import https from "node:https";

/**
 * Minimal server-side provider HTTP client shared by provider readiness
 * checks (provider-check.ts) and the Phase 9.7 Intent Router's mini
 * completion. Deliberately tiny: two wire protocols, no streaming, no
 * tooling. Keeps the Intent Router decoupled from PiRuntime.
 */

export type ProviderEndpoint = {
  api: string;
  apiKey: string;
  modelId: string;
  baseUrl: string;
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

/**
 * Streaming variant of callProvider for the conversation chat channel: posts
 * with stream:true and invokes onDelta per text piece as it arrives. Returns
 * the full concatenated text. Minimal SSE parsing — data lines only; OpenAI
 * deltas carry the text in choices[0].delta.content, Anthropic in
 * content_block_delta events.
 */
export async function streamProviderText(
  endpoint: ProviderEndpoint,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  timeoutMs = 120_000,
): Promise<string> {
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

    let full = "";
    let sse = "";

    const handleDataLine = (data: string) => {
      if (!data || data === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      let piece = "";
      if (openai) {
        const choices = chunk.choices as Array<{ delta?: { content?: string | null } }> | undefined;
        const c = choices?.[0]?.delta?.content;
        if (typeof c === "string" && c.length > 0) piece = c;
      } else {
        if (chunk.type === "error") {
          reject(new Error(JSON.stringify(chunk).slice(0, 300)));
          req.destroy();
          return;
        }
        const delta = (chunk.delta ?? {}) as { type?: string; text?: string };
        if (chunk.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
          piece = delta.text;
        }
      }
      if (piece) {
        full += piece;
        onDelta(piece);
      }
    };

    const req = https.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 443,
        path: apiPath,
        method: "POST",
        headers,
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          let errBody = "";
          res.on("data", (c: Buffer) => (errBody += c.toString("utf8")));
          res.on("end", () => {
            clearTimeout(timer);
            reject(new Error(`provider ${res.statusCode}: ${errBody.slice(0, 300)}`));
          });
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          sse += chunk;
          let idx: number;
          while ((idx = sse.indexOf("\n")) !== -1) {
            const line = sse.slice(0, idx).replace(/\r$/, "");
            sse = sse.slice(idx + 1);
            if (line.startsWith("data:")) {
              handleDataLine(line.slice(5).trimStart());
            }
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          resolveP(full);
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`stream timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.write(JSON.stringify({ ...body, stream: true }));
    req.end();
  });
}
