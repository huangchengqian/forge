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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBeforeToolCall } from "./before-tool-call.ts";
import { UsageTracker } from "./usage-tracker.ts";
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
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
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
    completion: { trustLevel: "medium", criteria: [],  maxTurns: null },
    approval: { request: async () => true },
    steeringQueue: [],
    usage: new UsageTracker(),
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

/** Parse the journal JSONL written by the hook (journal.ts no longer exports a reader). */
function readJournalLines(undoRoot: string): Array<{ path: string; backup: string | null; action: string }> {
  const raw = readFileSync(join(undoRoot, "journal.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

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
    const entries = readJournalLines(undoRoot);
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
    const entries = readJournalLines(undoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.action, "created");
    assert.equal(entries[0]!.backup, null);
  });
});

describe("beforeToolCall → abort wiring", () => {
  test("Stop wins over a pending approval wait (the 卡死 bug)", async () => {
    // bash is "ask" by default. The approval relay never answers — the old
    // implementation blocked here for the full 5-minute timeout and ignored
    // the abort signal, so a Stop press did nothing while the model's retry
    // re-armed the wait forever.
    const never: GuardrailConfig = {
      ...config(join(TMP, "undo-abort")),
      approval: { request: () => new Promise<boolean>(() => {}) },
    };
    const hook = makeBeforeToolCall(never);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await Promise.race([
      hook(
        { toolCall: { name: "bash", id: "call-5" }, args: { command: "ls -la /tmp/x" } } as never,
        controller.signal,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hook still blocked 500ms after abort")), 500),
      ),
    ]);
    assert.ok(result && result.block === true, "aborted call is blocked");
    assert.equal(result.terminate, true, "aborted call terminates the session");
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
