/**
 * Model discovery tests against a local fixture server — deterministic, no
 * external network (CI has none). Covers URL building per protocol, auth
 * header shape, response parsing (dedupe + sort), and HTTP error mapping.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { discoverModels, modelsEndpoint, parseModelsResponse } from "./model-discovery.ts";

let server: Server;
let baseUrl = "";
let lastReq: { url: string; auth: string | undefined; xApiKey: string | undefined; version: string | undefined } = {
  url: "",
  auth: undefined,
  xApiKey: undefined,
  version: undefined,
};

before(async () => {
  server = createServer((req, res) => {
    lastReq = {
      url: req.url ?? "",
      auth: req.headers.authorization as string | undefined,
      xApiKey: req.headers["x-api-key"] as string | undefined,
      version: req.headers["anthropic-version"] as string | undefined,
    };
    if (req.url?.includes("/unauthorized")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("modelsEndpoint URL building", () => {
  test("openai baseUrl already carrying /v1 → /models", () => {
    assert.equal(
      modelsEndpoint({ api: "openai-completions", baseUrl: "https://api.openai.com/v1/", apiKey: "k" }),
      "https://api.openai.com/v1/models",
    );
  });

  test("openai baseUrl without a version segment → /v1/models", () => {
    assert.equal(
      modelsEndpoint({ api: "openai-completions", baseUrl: "https://api.deepseek.com", apiKey: "k" }),
      "https://api.deepseek.com/v1/models",
    );
  });

  test("anthropic baseUrl gets /v1/models plus a page limit", () => {
    assert.equal(
      modelsEndpoint({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "k" }),
      "https://api.anthropic.com/v1/models?limit=1000",
    );
  });
});

describe("parseModelsResponse", () => {
  test("dedupes and sorts ids; tolerates junk", () => {
    assert.deepEqual(parseModelsResponse({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, null, {}] }), ["a", "b"]);
    assert.deepEqual(parseModelsResponse({ error: "nope" }), []);
    assert.deepEqual(parseModelsResponse(null), []);
  });
});

describe("discoverModels against a fixture server", () => {
  test("openai-completions: Bearer auth, GET /v1/models, parsed ids", async () => {
    const models = await discoverModels({
      api: "openai-completions",
      baseUrl: `${baseUrl}/v1`,
      apiKey: "sk-test",
    });
    assert.deepEqual(models, ["model-a", "model-b"]);
    assert.equal(lastReq.url, "/v1/models");
    assert.equal(lastReq.auth, "Bearer sk-test");
  });

  test("anthropic-messages: x-api-key + version header, /v1/models path", async () => {
    const models = await discoverModels({
      api: "anthropic-messages",
      baseUrl: baseUrl,
      apiKey: "ak-test",
    });
    assert.deepEqual(models, ["model-a", "model-b"]);
    assert.equal(lastReq.url, "/v1/models?limit=1000");
    assert.equal(lastReq.xApiKey, "ak-test");
    assert.equal(lastReq.version, "2023-06-01");
  });

  test("HTTP 401 maps to a thrown error with the status", async () => {
    await assert.rejects(
      discoverModels({
        api: "openai-responses",
        baseUrl: `${baseUrl}/unauthorized/v1`,
        apiKey: "bad",
      }),
      /HTTP 401/,
    );
  });
});
