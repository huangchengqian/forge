import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeGuardHandler } from "./extension.ts";
import { defaultPolicy, type GuardPolicy } from "./policy.ts";
import type { ToolCallEvent, GuardContext } from "./extension.ts";

function makeCtx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    ui: { confirm: async () => true },
    hasUI: true,
    cwd: "/tmp",
    ...overrides,
  };
}

function makeEvent(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: "tool_call", toolName, toolCallId: "t1", input };
}

/** Explicit ask policy to exercise the approval path (defaults are interim-allow). */
const ASK_POLICY: GuardPolicy = {
  version: 1,
  default: "ask",
  rules: [
    { id: "destructive-deny", capability: "destructive", decision: "deny", terminate: true },
    { id: "bash-ask", capability: "bash", decision: "ask" },
  ],
};

describe("forge-guard extension handler", () => {
  test("allow decision passes through (undefined)", async () => {
    const handler = makeGuardHandler(defaultPolicy());
    const result = await handler(makeEvent("read", { path: "a.ts" }), makeCtx());
    assert.equal(result, undefined);
  });

  test("deny decision blocks with reason + terminate", async () => {
    const handler = makeGuardHandler(defaultPolicy());
    const result = await handler(makeEvent("bash", { command: "rm -rf /" }), makeCtx());
    assert.ok(result);
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.match(result.reason ?? "", /destructive-deny/);
  });

  test("ask + user confirms → pass through", async () => {
    let asked = 0;
    const handler = makeGuardHandler(ASK_POLICY, { askFallback: "block" });
    const result = await handler(
      makeEvent("bash", { command: "npm install" }),
      makeCtx({ ui: { confirm: async () => { asked++; return true; } } }),
    );
    assert.equal(result, undefined);
    assert.equal(asked, 1);
  });

  test("ask + user rejects → block", async () => {
    const handler = makeGuardHandler(ASK_POLICY, { askFallback: "block" });
    const result = await handler(
      makeEvent("bash", { command: "npm install" }),
      makeCtx({ ui: { confirm: async () => false } }),
    );
    assert.ok(result);
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /rejected by user/);
  });

  test("ask + fallback=block without UI → block (fail safe)", async () => {
    const handler = makeGuardHandler(ASK_POLICY, { askFallback: "block" });
    const result = await handler(makeEvent("bash", { command: "npm install" }), makeCtx({ hasUI: false }));
    assert.ok(result);
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /no UI/);
  });

  test("ask + fallback=allow → pass through without prompting (headless CLI)", async () => {
    let asked = 0;
    const handler = makeGuardHandler(ASK_POLICY, { askFallback: "allow" });
    const result = await handler(
      makeEvent("bash", { command: "npm install" }),
      makeCtx({ hasUI: false, ui: { confirm: async () => { asked++; return true; } } }),
    );
    assert.equal(result, undefined);
    assert.equal(asked, 0);
  });

  test("confirm throws → fail closed", async () => {
    const handler = makeGuardHandler(ASK_POLICY, { askFallback: "block" });
    const result = await handler(
      makeEvent("bash", { command: "npm install" }),
      makeCtx({ ui: { confirm: async () => { throw new Error("ui down"); } } }),
    );
    assert.ok(result);
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /forge-guard error/);
  });

  test("custom policy: all write allowed; bash still ask-gated", async () => {
    const policy: GuardPolicy = { version: 1, default: "ask", rules: [{ id: "w", capability: "write", decision: "allow" }] };
    const handler = makeGuardHandler(policy);
    // write → allow, no prompt
    let confirmCalls = 0;
    assert.equal(await handler(makeEvent("write", { path: "x" }), makeCtx({ ui: { confirm: async () => { confirmCalls++; return true; } } })), undefined);
    assert.equal(confirmCalls, 0);
    // bash → ask → user rejects → block
    const result = await handler(makeEvent("bash", { command: "echo hi" }), makeCtx({ ui: { confirm: async () => false } }));
    assert.ok(result);
    assert.equal(result.block, true);
  });

  test("write/edit tools are journaled before execution (9.6.6)", async () => {
    const { mkdirSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const undoRoot = "/tmp/forge-guard-journal-test";
    const cwd = join(undoRoot, "ws");
    rmSync(undoRoot, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "a.ts"), "original\n", "utf8");
    process.env.FORGE_UNDO_DIR = join(undoRoot, "undo", "t1");
    try {
      const policy: GuardPolicy = { version: 1, default: "ask", rules: [{ id: "w", capability: "write", decision: "allow" }] };
      const handler = makeGuardHandler(policy);
      await handler(makeEvent("write", { path: "a.ts", content: "new\n" }), makeCtx({ cwd }));
      const { readJournal } = await import("./journal.ts");
      const entries = await readJournal(process.env.FORGE_UNDO_DIR);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.action, "modified");
      assert.ok(entries[0]?.backup && existsSync(entries[0].backup));
      assert.equal(existsSync(join(cwd, "a.ts")), true);
    } finally {
      delete process.env.FORGE_UNDO_DIR;
      rmSync(undoRoot, { recursive: true, force: true });
    }
  });
});
