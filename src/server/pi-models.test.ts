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
  test("openai-completions provider writes models.json and returns custom", async () => {
    const name = await syncCustomModels(HOME, {
      api: "openai-completions",
      apiKey: "sk-test",
      modelId: "gpt-4o-mini",
      baseUrl: "https://gateway.example.com/v1",
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

  test("anthropic-messages protocol is honored", async () => {
    const name = await syncCustomModels(HOME, {
      api: "anthropic-messages",
      apiKey: "sk-anthropic",
      modelId: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    });
    assert.equal(name, CUSTOM_PROVIDER_NAME);
    const parsed = JSON.parse(readFileSync(join(piAgentDir(HOME), "models.json"), "utf8"));
    assert.equal(parsed.providers.custom.api, "anthropic-messages");
    assert.equal(parsed.providers.custom.baseUrl, "https://api.anthropic.com");
  });

  test("every provider is written to models.json (no built-in fast path)", async () => {
    const fresh = join(TMP, "fresh-home");
    mkdirSync(fresh, { recursive: true });
    const name = await syncCustomModels(fresh, {
      api: "anthropic-messages",
      apiKey: "k",
      modelId: "m",
      baseUrl: "https://api.minimax.io/anthropic",
    });
    assert.equal(name, CUSTOM_PROVIDER_NAME);
    assert.equal(existsSync(join(piAgentDir(fresh), "models.json")), true);
  });
});
