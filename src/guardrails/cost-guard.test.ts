import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CostGuard } from "./cost-guard.ts";

describe("CostGuard", () => {
  test("starts at zero with no budget", () => {
    const g = new CostGuard(null);
    assert.equal(g.getSpent(), 0);
    assert.equal(g.getLastInputTokens(), null);
    assert.equal(g.getRemaining(), null);
    assert.equal(g.isExhausted(), false);
  });

  test("trackUsage accumulates cost.total and remembers last input", () => {
    const g = new CostGuard(null);
    g.trackUsage({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    });
    assert.equal(g.getSpent(), 0.003);
    assert.equal(g.getLastInputTokens(), 100);

    g.trackUsage({
      input: 200,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 280,
      cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
    });
    assert.equal(g.getSpent(), 0.008);
    // lastInputTokens reflects the most recent turn, NOT a cumulative sum.
    assert.equal(g.getLastInputTokens(), 200);
  });

  test("trackUsage handles undefined or non-finite values without crashing", () => {
    const g = new CostGuard(null);
    g.trackUsage(undefined);
    assert.equal(g.getSpent(), 0);
    assert.equal(g.getLastInputTokens(), null);

    g.trackUsage({
      input: Number.NaN,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.NaN },
    });
    assert.equal(g.getSpent(), 0);
    assert.equal(g.getLastInputTokens(), null);
  });

  test("isExhausted + getRemaining respect the budget", () => {
    const g = new CostGuard(0.01);
    g.trackUsage({
      input: 50,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 },
    });
    assert.equal(g.isExhausted(), false);
    assert.equal(g.getRemaining(), 0.005);

    g.trackUsage({
      input: 50,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.006 },
    });
    assert.equal(g.isExhausted(), true);
    assert.equal(g.getRemaining(), 0);
  });

  test("hydrate restores spent and (best-effort) lastInputTokens", () => {
    const g = new CostGuard(1.0);
    g.hydrate(0.42, 7777);
    assert.equal(g.getSpent(), 0.42);
    assert.equal(g.getLastInputTokens(), 7777);
    assert.equal(g.isExhausted(), false);
    assert.ok(Math.abs(g.getRemaining()! - 0.58) < 1e-9);

    // Subsequent trackUsage replaces — does not add to — hydrated values.
    g.trackUsage({
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    });
    assert.equal(g.getSpent(), 0.43);
    assert.equal(g.getLastInputTokens(), 100);
  });

  test("hydrate accepts null lastInputTokens (resume before any message_end)", () => {
    const g = new CostGuard(null);
    g.hydrate(0.05, null);
    assert.equal(g.getSpent(), 0.05);
    assert.equal(g.getLastInputTokens(), null);
  });
});