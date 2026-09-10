/**
 * Regression tests for the beforeToolCall hook's two wiring bugs found in the
 * architecture review (docs/27 §5.2 / §5.3) — both were silent no-ops:
 *
 *   1. Undo journaling read `process.env.FORGE_UNDO_DIR`, which nothing in
 *      production ever set, so `journalFile` returned null immediately. The
 *      fix threads an explicit per-session `undoRoot` through GuardrailConfig.
 *   2. The capability policy called `loadPolicy()` with no path, which always
 *      returned the built-in default and ignored the user's `guard.json`. The
 *      fix passes `defaultPolicyPath()`.
 *
 * These are integration-level (hook + journal + policy file) because the
 * failure mode was "each unit passes, the wire between them is missing".
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBeforeToolCall } from "./before-tool-call.ts";
import { readJournal } from "../guard/journal.ts";
import { CostGuard } from "./cost-guard.ts";
import type { GuardrailConfig } from "./types.ts";
import type { Session } from "../types.ts";

const TMP = "/tmp/forge-guard-wiring-tests";
const WS = join(TMP, "ws");

function stubSession(workspace: string): Session {
  return {
    id: "session-guard-test",
    kind: "task",
    goal: "test",
    workspace,
    projectId: null,
    model: { provider: "stub", modelId: "stub" },
    messages: [],
    status: "running",
    failureReason: null,
    cost: { total: 0, budget: null },
    trustLevel: "medium",
    thinkingLevel: "off",
    completionCriteria: [],
    lastEvaluation: null,
    maxTurns: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function config(undoRoot: string): GuardrailConfig {
  return {
    sessionId: "session-guard-test",
    workspace: WS,
    undoRoot,
    session: stubSession(WS),
    completion: { trustLevel: "medium", criteria: [], maxCost: null, maxTurns: null },
    approval: { request: async () => true },
    steeringQueue: [],
    costGuard: new CostGuard(null),
  };
}

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FORGE_GUARD_POLICY;
});

describe("beforeToolCall → undo journal wiring", () => {
  test("a write tool call journals the target under config.undoRoot", async () => {
    const undoRoot = join(TMP, "undo-write");
    const target = join(WS, "guard-target.txt");
    writeFileSync(target, "before\n", "utf8");

    const hook = makeBeforeToolCall(config(undoRoot));
    const result = await hook({
      toolCall: { name: "write", id: "call-1" },
      args: { path: "guard-target.txt", content: "after\n" },
    } as never);

    assert.equal(result, undefined, "write is allowed by default policy");
    const entries = await readJournal(undoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.action, "modified");
    assert.equal(entries[0]!.path, target);
    assert.ok(entries[0]!.backup && existsSync(entries[0]!.backup!));
  });

  test("a created file journals with a null backup", async () => {
    const undoRoot = join(TMP, "undo-create");
    const hook = makeBeforeToolCall(config(undoRoot));
    const result = await hook({
      toolCall: { name: "edit", id: "call-2" },
      args: { path: "brand-new.txt" },
    } as never);

    assert.equal(result, undefined);
    const entries = await readJournal(undoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.action, "created");
    assert.equal(entries[0]!.backup, null);
  });
});

describe("beforeToolCall → user policy wiring", () => {
  test("a user rule in guard.json is honored (deny overrides the default allow)", async () => {
    const policyPath = join(TMP, "guard-deny-write.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        default: "ask",
        rules: [{ id: "deny-write", capability: "write", decision: "deny" }],
      }),
      "utf8",
    );

    const prev = process.env.FORGE_GUARD_POLICY;
    process.env.FORGE_GUARD_POLICY = policyPath;
    try {
      const hook = makeBeforeToolCall(config(join(TMP, "undo-policy")));
      const result = await hook({
        toolCall: { name: "write", id: "call-3" },
        args: { path: "anything.txt" },
      } as never);
      assert.ok(result && result.block === true, "user deny rule blocks the call");
    } finally {
      if (prev === undefined) delete process.env.FORGE_GUARD_POLICY;
      else process.env.FORGE_GUARD_POLICY = prev;
    }
  });

  test("with no user file the built-in default allows write", async () => {
    const prev = process.env.FORGE_GUARD_POLICY;
    process.env.FORGE_GUARD_POLICY = join(TMP, "does-not-exist.json");
    try {
      const hook = makeBeforeToolCall(config(join(TMP, "undo-default")));
      const result = await hook({
        toolCall: { name: "write", id: "call-4" },
        args: { path: "anything.txt" },
      } as never);
      assert.equal(result, undefined);
    } finally {
      if (prev === undefined) delete process.env.FORGE_GUARD_POLICY;
      else process.env.FORGE_GUARD_POLICY = prev;
    }
  });
});
