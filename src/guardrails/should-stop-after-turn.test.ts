/**
 * Unit tests for the shouldStopAfterTurn gate's two transparent-recovery and
 * stuck paths that the constitution (AGENTS.md Rule 5.3 / 5.5) promises:
 *
 *   - empty stop → "try again" steering, max 3, then an honest failure
 *   - monologue (task session, 4 consecutive text-only turns) → stuck
 *     termination with `stuck detected: ...` failureReason
 *   - conversation sessions are exempt from the monologue guard
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeShouldStopAfterTurn } from "./should-stop-after-turn.ts";
import { UsageTracker } from "./usage-tracker.ts";
import type { GuardrailConfig } from "./types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Session, TrustLevel } from "../types.ts";

const TMP = mkdtempSync(join(tmpdir(), "forge-stop-gate-tests-"));

function makeSession(kind: Session["kind"]): Session {
  return {
    id: "session-stop-gate-test",
    kind,
    goal: "test",
    workspace: TMP,
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeConfig(
  session: Session,
  trustLevel: TrustLevel = "low",
  criteria: Session["completionCriteria"] = [],
): {
  config: GuardrailConfig;
  steered: string[];
} {
  const steered: string[] = [];
  const config: GuardrailConfig = {
    sessionId: session.id,
    workspace: session.workspace,
    undoRoot: join(TMP, "undo"),
    session,
    completion: { trustLevel, criteria},
    approval: { request: async () => true },
    steeringQueue: {
      push: (m: AgentMessage) => {
        const c = (m as { content?: unknown }).content as Array<{ type: string; text?: string }>;
        steered.push((c ?? []).map((b) => (b.type === "text" ? b.text ?? "" : "")).join(""));
      },
    } as unknown as GuardrailConfig["steeringQueue"],
    usage: new UsageTracker(),
  };
  return { config, steered };
}

function stopTurn(text: string): { message: unknown } {
  return {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

before(() => {
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");
});

after(() => {
  delete process.env.FORGE_EVENTS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("empty stop recovery (Rule 5.5)", () => {
  test("steers up to 3 times, then surfaces an honest failure", async () => {
    const session = makeSession("task");
    const { config, steered } = makeConfig(session);
    const gate = makeShouldStopAfterTurn(config);
    const emptyTurn = { message: { role: "assistant", stopReason: "stop", content: [] } };

    assert.equal(await gate(emptyTurn as never), false);
    assert.equal(await gate(emptyTurn as never), false);
    assert.equal(await gate(emptyTurn as never), false);
    assert.equal(steered.length, 3, "three recovery attempts steered");

    assert.equal(await gate(emptyTurn as never), true, "4th empty stop ends the run");
    assert.equal(session.failureReason, "empty response after retries");
  });

  test("a non-empty stop is not treated as empty", async () => {
    const session = makeSession("task");
    const { config } = makeConfig(session);
    const gate = makeShouldStopAfterTurn(config);
    // trustLevel low → a normal stop ends the run without steering.
    assert.equal(await gate(stopTurn("done") as never), true);
  });
});

describe("monologue guard (Rule 5.3)", () => {
  // The monologue path only matters when the gate would otherwise return
  // false on a stop turn — i.e. verification failing and steering the model
  // to continue. A criterion that can never pass provides exactly that.
  const neverPasses = [{ kind: "file_exists" as const, path: "no-such-file-ever.txt" }];

  test("4 consecutive text-only turns kill a task session", async () => {
    const session = makeSession("task");
    const { config } = makeConfig(session, "medium", neverPasses);
    const gate = makeShouldStopAfterTurn(config);

    assert.equal(await gate(stopTurn("thinking...") as never), false, "turn 1 keeps going");
    assert.equal(await gate(stopTurn("still thinking...") as never), false, "turn 2 keeps going");
    assert.equal(await gate(stopTurn("more words...") as never), false, "turn 3 keeps going");
    assert.equal(await gate(stopTurn("...") as never), true, "turn 4 terminates");
    assert.match(session.failureReason ?? "", /stuck detected: monologue/);
  });

  test("a toolUse turn resets the counter", async () => {
    const session = makeSession("task");
    const { config } = makeConfig(session, "medium", neverPasses);
    const gate = makeShouldStopAfterTurn(config);
    const toolTurn = {
      message: { role: "assistant", stopReason: "toolUse", content: [] },
    };

    assert.equal(await gate(stopTurn("a") as never), false);
    assert.equal(await gate(stopTurn("b") as never), false);
    assert.equal(await gate(toolTurn as never), false);
    assert.equal(await gate(stopTurn("c") as never), false);
    assert.equal(await gate(stopTurn("d") as never), false);
    assert.equal(session.failureReason, null, "counter reset — only 2 consecutive");
  });

  test("conversation sessions are exempt — they legitimately talk", async () => {
    const session = makeSession("conversation");
    const { config } = makeConfig(session, "medium", neverPasses);
    const gate = makeShouldStopAfterTurn(config);

    for (let i = 0; i < 6; i++) {
      assert.equal(await gate(stopTurn(`chat ${i}`) as never), false, `turn ${i + 1} keeps going`);
    }
    assert.equal(session.failureReason, null);
  });
});
