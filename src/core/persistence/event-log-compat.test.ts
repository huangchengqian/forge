/**
 * Forward-only disk discipline: the JSONL event log is a real boundary
 * (code ↔ disk). `taskId` was renamed to `sessionId` on 2026-09-12 — logs
 * written before that carry the old name and MUST keep working.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEvents } from "./event-log.ts";

const DIR = join(tmpdir(), `forge-eventlog-compat-${process.pid}`);

describe("event log legacy-field compat", () => {
  test("a pre-rename line (taskId) reads back as sessionId", async () => {
    process.env.FORGE_EVENTS_DIR = DIR;
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const sessionId = "session_legacy_1";
    writeFileSync(
      join(DIR, `${sessionId}.events.jsonl`),
      JSON.stringify({
        id: "ev1",
        type: "SESSION_CREATED",
        taskId: sessionId,
        at: 1700000000000,
        payload: { goal: "old log" },
      }) + "\n",
      "utf8",
    );

    const events = await readEvents(sessionId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.sessionId, sessionId, "legacy taskId is normalized");
    assert.equal(events[0]!.payload.goal, "old log");
  });

  test("new lines carry sessionId and survive a round trip", async () => {
    process.env.FORGE_EVENTS_DIR = DIR;
    const sessionId = "session_new_1";
    writeFileSync(
      join(DIR, `${sessionId}.events.jsonl`),
      JSON.stringify({ id: "ev2", type: "SESSION_ENDED", sessionId, at: 1, payload: {} }) + "\n",
      "utf8",
    );
    const events = await readEvents(sessionId);
    assert.equal(events[0]!.sessionId, sessionId);
    rmSync(DIR, { recursive: true, force: true });
  });
});
