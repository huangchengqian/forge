import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { syncCustomModels, piAgentDir, CUSTOM_PROVIDER_NAME } from "./pi-models.ts";

const TMP = "/tmp/forge-pi-models-tests";
const HOME = join(TMP, "home");

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("syncCustomModels", () => {
  test("openai-compatible writes models.json and returns the custom provider name", async () => {
    const name = await syncCustomModels(HOME, {
      kind: "openai-compatible",
      apiKey: "sk-test",
      modelId: "gpt-4o-mini",
      baseUrl: "https://gateway.example.com/v1",
      api: "openai-completions",
    });
    assert.equal(name, CUSTOM_PROVIDER_NAME);

    const file = join(piAgentDir(HOME), "models.json");
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(parsed.providers.custom);
    assert.equal(parsed.providers.custom.api, "openai-completions");
    assert.equal(parsed.providers.custom.baseUrl, "https://gateway.example.com/v1");
    assert.equal(parsed.providers.custom.models[0].id, "gpt-4o-mini");
  });

  test("anthropic protocol choice is honored", async () => {
    const name = await syncCustomModels(HOME, {
      kind: "openai-compatible",
      apiKey: "sk-anthropic",
      modelId: "claude-sonnet",
      baseUrl: "https://gateway.example.com/anthropic",
      api: "anthropic-messages",
    });
    assert.equal(name, CUSTOM_PROVIDER_NAME);
    const parsed = JSON.parse(readFileSync(join(piAgentDir(HOME), "models.json"), "utf8"));
    assert.equal(parsed.providers.custom.api, "anthropic-messages");
  });

  test("built-in providers are not written to models.json", async () => {
    const name = await syncCustomModels(HOME, {
      kind: "anthropic",
      apiKey: "sk",
      modelId: "claude-opus-4-8",
      baseUrl: "https://api.anthropic.com",
    });
    assert.equal(name, "anthropic");
    // models.json may exist from prior cases; a fresh home should not get one.
    const fresh = join(TMP, "fresh-home");
    mkdirSync(fresh, { recursive: true });
    await syncCustomModels(fresh, { kind: "minimax", apiKey: "k", modelId: "m", baseUrl: "https://x" });
    assert.equal(existsSync(join(piAgentDir(fresh), "models.json")), false);
  });
});
