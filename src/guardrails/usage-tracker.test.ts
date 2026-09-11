import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker } from "./usage-tracker.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
});

describe("UsageTracker", () => {
  test("accumulates token counters across messages", () => {
    const t = new UsageTracker();
    t.trackUsage(usage(100, 20) as never);
    t.trackUsage(usage(200, 30, 50) as never);
    const s = t.snapshot();
    assert.equal(s.tokensIn, 300);
    assert.equal(s.tokensOut, 50);
    assert.equal(s.cacheRead, 50);
  });

  test("watermark follows the latest message, not the cumulative sum", () => {
    const t = new UsageTracker();
    t.trackUsage(usage(1000, 10) as never);
    assert.equal(t.getLastContextTokens(), 1010);
    t.trackUsage(usage(1500, 10) as never);
    assert.equal(t.getLastContextTokens(), 1510, "latest turn wins");
  });

  test("ignores garbage usage and zero/negative context", () => {
    const t = new UsageTracker();
    t.trackUsage(undefined);
    t.trackUsage({ input: Number.NaN } as never);
    assert.equal(t.getLastContextTokens(), null);
    assert.equal(t.snapshot().tokensIn, 0);
  });

  test("hydrate restores a resume snapshot", () => {
    const t = new UsageTracker();
    t.hydrate({ tokensIn: 4200, tokensOut: 300, cacheRead: 100, cacheWrite: 0, lastContextTokens: 4500 });
    const s = t.snapshot();
    assert.equal(s.tokensIn, 4200);
    assert.equal(s.lastContextTokens, 4500);
    t.trackUsage(usage(100, 5) as never);
    assert.equal(s.tokensIn, 4200, "snapshot is a copy");
    assert.equal(t.snapshot().tokensIn, 4300);
  });
});
