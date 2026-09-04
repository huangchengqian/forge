import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadForgeConfig, saveForgeConfig, validateProvider, PROVIDER_PRESETS } from "./config-store.ts";

const TMP = "/tmp/forge-config-store-tests";
const HOME = join(TMP, "home");

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("validateProvider", () => {
  test("accepts the protocol-first shape", () => {
    const p = validateProvider({
      api: "anthropic-messages",
      apiKey: "sk",
      modelId: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    });
    assert.deepEqual(p, {
      api: "anthropic-messages",
      apiKey: "sk",
      modelId: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    });
  });

  test("rejects unknown protocol", () => {
    assert.equal(validateProvider({ api: "google-generative-ai", apiKey: "k", modelId: "m", baseUrl: "https://x" }), null);
  });

  test("rejects missing api / empty fields", () => {
    assert.equal(validateProvider({ apiKey: "k", modelId: "m", baseUrl: "https://x" }), null);
    assert.equal(validateProvider({ api: "openai-completions", apiKey: "", modelId: "m", baseUrl: "https://x" }), null);
    assert.equal(validateProvider({ api: "openai-completions", apiKey: "k", modelId: " ", baseUrl: "https://x" }), null);
  });
});

describe("presets", () => {
  test("presets pin protocol + baseUrl + default model", () => {
    const mini = PROVIDER_PRESETS.find((p) => p.id === "minimax");
    assert.equal(mini?.api, "anthropic-messages");
    assert.equal(mini?.baseUrl, "https://api.minimax.io/anthropic");
    assert.equal(mini?.defaultModel, "MiniMax-M3");
    const openai = PROVIDER_PRESETS.find((p) => p.id === "openai");
    assert.equal(openai?.api, "openai-responses");
    const deepseek = PROVIDER_PRESETS.find((p) => p.id === "deepseek");
    assert.equal(deepseek?.api, "openai-completions");
  });
});

describe("legacy config migration", () => {
  test("kind=anthropic migrates to anthropic-messages", async () => {
    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "anthropic", apiKey: "sk", modelId: "claude-opus-4-8", baseUrl: "https://api.anthropic.com" },
      maxConcurrency: 2,
    }));
    const cfg = await loadForgeConfig(HOME);
    assert.equal(cfg.provider?.api, "anthropic-messages");
    assert.equal(cfg.provider?.baseUrl, "https://api.anthropic.com");
  });

  test("kind=minimax migrates to anthropic-messages", async () => {
    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "minimax", apiKey: "sk", modelId: "MiniMax-M3", baseUrl: "https://api.minimax.io/anthropic" },
      maxConcurrency: 2,
    }));
    const cfg = await loadForgeConfig(HOME);
    assert.equal(cfg.provider?.api, "anthropic-messages");
  });

  test("kind=openai-compatible keeps its api (defaults to openai-completions)", async () => {
    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "openai-compatible", apiKey: "sk", modelId: "gpt-4o", baseUrl: "https://gw/v1", api: "openai-responses" },
      maxConcurrency: 2,
    }));
    assert.equal((await loadForgeConfig(HOME)).provider?.api, "openai-responses");

    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "openai-compatible", apiKey: "sk", modelId: "gpt-4o", baseUrl: "https://gw/v1" },
      maxConcurrency: 2,
    }));
    assert.equal((await loadForgeConfig(HOME)).provider?.api, "openai-completions");
  });

  test("new shape round-trips through save/load", async () => {
    const provider = { api: "openai-completions" as const, apiKey: "sk", modelId: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" };
    await saveForgeConfig(HOME, { version: 1, provider, maxConcurrency: 3 });
    const cfg = await loadForgeConfig(HOME);
    assert.deepEqual(cfg.provider, provider);
    assert.equal(cfg.maxConcurrency, 3);
  });
});
