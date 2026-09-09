import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentContext,
  PrepareNextTurnContext,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  makePrepareNextTurn,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_KEEP_RECENT_MESSAGES,
} from "./compaction.ts";
import { CostGuard } from "./cost-guard.ts";

function userMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as AgentMessage;
}

function makeCtx(messages: AgentMessage[]): PrepareNextTurnContext {
  const ctx: AgentContext = { systemPrompt: "sys", messages };
  // Construct the context the way Pi's agent-loop would. We only use a
  // minimal subset of fields.
  return { context: ctx } as unknown as PrepareNextTurnContext;
}

function capturedEvents(): Array<{ type: string; payload: Record<string, unknown> }> {
  const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return captured;
}

describe("makePrepareNextTurn (truncate-mode compaction)", () => {
  test("returns undefined when lastInputTokens is null (no usage yet)", async () => {
    const costGuard = new CostGuard(null);
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "x",
      costGuard,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    const ctx = makeCtx([userMsg("a"), userMsg("b")]);
    const out = await prepare(ctx);
    assert.equal(out, undefined);
    assert.equal(events.length, 0);
  });

  test("returns undefined when lastInputTokens <= threshold", async () => {
    const costGuard = new CostGuard(null);
    costGuard.hydrate(0, 100_000);
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "x",
      costGuard,
      thresholdTokens: 120_000,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    const ctx = makeCtx(Array.from({ length: 30 }, (_, i) => userMsg(`m${i}`)));
    const out = await prepare(ctx);
    assert.equal(out, undefined);
    assert.equal(events.length, 0);
  });

  test("returns undefined when message count <= keepRecent (don't drop goal)", async () => {
    const costGuard = new CostGuard(null);
    costGuard.hydrate(0, 200_000); // above threshold
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "x",
      costGuard,
      thresholdTokens: 120_000,
      keepRecentMessages: 5,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    // Only 3 messages — would risk dropping the goal prompt if truncated.
    const ctx = makeCtx([userMsg("a"), userMsg("b"), userMsg("c")]);
    const out = await prepare(ctx);
    assert.equal(out, undefined);
    assert.equal(events.length, 0);
  });

  test("truncates to keepRecentMessages and emits COMPACTION event", async () => {
    const costGuard = new CostGuard(null);
    costGuard.hydrate(0, 200_000); // above threshold
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      costGuard,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    const original = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`));
    const ctx = makeCtx(original);
    const out = await prepare(ctx);

    assert.ok(out);
    assert.ok(out!.context);
    const newMessages = out!.context!.messages!;
    assert.equal(newMessages.length, 3);
    const texts = newMessages.map(
      (m) => ((m as unknown as { content: Array<{ text: string }> }).content[0]!.text),
    );
    assert.equal(texts.join(","), "m7,m8,m9");

    // systemPrompt preserved, tools preserved when defined.
    assert.equal(out!.context!.systemPrompt, "sys");

    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.type, "COMPACTION");
    assert.equal(ev.payload.mode, "truncate");
    assert.equal(ev.payload.beforeCount, 10);
    assert.equal(ev.payload.afterCount, 3);
    assert.equal(ev.payload.droppedCount, 7);
    assert.equal(ev.payload.beforeTokens, 200_000);
    assert.equal(ev.payload.threshold, 120_000);
  });

  test("does not break the loop when emitEvent throws", async () => {
    const costGuard = new CostGuard(null);
    costGuard.hydrate(0, 200_000);
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      costGuard,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: () => Promise.reject(new Error("disk full")),
    });
    const ctx = makeCtx(Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`)));
    // Must not throw — the .catch(() => {}) inside the hook swallows it.
    const out = await prepare(ctx);
    assert.ok(out);
    assert.equal(out!.context!.messages!.length, 3);
  });

  test("uses defaults when threshold/keepRecent not provided", () => {
    // Sanity: the named defaults are what we documented (120K, 20).
    assert.equal(DEFAULT_COMPACTION_THRESHOLD, 120_000);
    assert.equal(DEFAULT_KEEP_RECENT_MESSAGES, 20);
  });
});