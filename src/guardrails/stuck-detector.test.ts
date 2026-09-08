import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StuckDetector } from "./stuck-detector.ts";

describe("StuckDetector", () => {
  test("same action + same error repeated 4x -> action_error_loop", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 4; i++) {
      d.track({ toolName: "bash", args: { command: "npm test" }, result: "ERR", isError: true });
      assert.equal(d.check().isStuck, i < 3 ? false : true);
    }
    const r = d.check();
    assert.equal(r.isStuck, true);
    if (r.isStuck) assert.equal(r.pattern, "action_error_loop");
  });

  test("same action + same success observation 4x -> action_observation_loop", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 4; i++) {
      d.track({ toolName: "read", args: { path: "a.ts" }, result: "same", isError: false });
    }
    const r = d.check();
    assert.equal(r.isStuck, true);
    if (r.isStuck) assert.equal(r.pattern, "action_observation_loop");
  });

  test("different results on the same action do NOT trigger", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 4; i++) {
      d.track({ toolName: "bash", args: { command: "npm test" }, result: `out-${i}`, isError: false });
    }
    assert.equal(d.check().isStuck, false);
  });

  test("alternating A→B→A→B (6x) -> alternating_pattern", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 6; i++) {
      const isA = i % 2 === 0;
      d.track({
        toolName: isA ? "read" : "write",
        args: { path: isA ? "a.ts" : "b.ts" },
        result: "ok",
        isError: false,
      });
    }
    const r = d.check();
    assert.equal(r.isStuck, true);
    if (r.isStuck) assert.equal(r.pattern, "alternating_pattern");
  });

  test("healthy varied history stays unstuck", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 10; i++) {
      d.track({
        toolName: "bash",
        args: { command: `step ${i}` },
        result: `out-${i}`,
        isError: i === 3,
      });
    }
    assert.equal(d.check().isStuck, false);
  });

  test("history is bounded (50 entries)", () => {
    const d = new StuckDetector();
    for (let i = 0; i < 60; i++) {
      d.track({ toolName: "read", args: { path: `f${i}.ts` }, result: "ok", isError: false });
    }
    assert.equal(d.check().isStuck, false);
  });
});
