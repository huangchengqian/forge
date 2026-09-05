import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { syncCustomModels, piAgentDir, providerName } from "./pi-models.ts";

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
  test("writes every subscription as its own provider entry", async () => {
    await syncCustomModels(HOME, [
      { id: "sub-anthropic", api: "anthropic-messages", apiKey: "sk-ant", modelId: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com" },
      { id: "sub-deepseek", api: "openai-completions", apiKey: "sk-ds", modelId: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" },
    ]);

    const file = join(piAgentDir(HOME), "models.json");
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf8"));

    assert.equal(parsed.providers["sub-anthropic"].api, "anthropic-messages");
    assert.equal(parsed.providers["sub-anthropic"].baseUrl, "https://api.anthropic.com");
    assert.equal(parsed.providers["sub-anthropic"].models[0].id, "claude-sonnet-4-6");

    assert.equal(parsed.providers["sub-deepseek"].api, "openai-completions");
    assert.equal(parsed.providers["sub-deepseek"].baseUrl, "https://api.deepseek.com");
    assert.equal(parsed.providers["sub-deepseek"].models[0].id, "deepseek-v4-pro");
  });

  test("providerName is the subscription id (used for --provider and set_model)", () => {
    assert.equal(providerName({ id: "sub-1", api: "openai-completions", apiKey: "k", modelId: "m", baseUrl: "https://x" }), "sub-1");
  });

  test("apiKey is stored in models.json (not env)", async () => {
    await syncCustomModels(HOME, [
      { id: "sub-k", api: "anthropic-messages", apiKey: "sk-secret", modelId: "m", baseUrl: "https://x" },
    ]);
    const parsed = JSON.parse(readFileSync(join(piAgentDir(HOME), "models.json"), "utf8"));
    assert.equal(parsed.providers["sub-k"].apiKey, "sk-secret");
  });
});
