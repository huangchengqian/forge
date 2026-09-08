import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SESSION_SCHEMA_VERSION, migrateSession, stampSchemaVersion } from "./schema.ts";

describe("session schema migration", () => {
  test("legacy v3 TaskSession migrates to Session v4", () => {
    const legacyTask = {
      schemaVersion: 3,
      id: "task_20260908_a1",
      goal: "create hello.txt",
      state: "COMPLETE",
      kind: "task",
      directory: "/tmp/old",
      workspacePath: "/tmp/project",
      projectId: "p1",
      model: { provider: "custom", modelId: "gpt-x" },
      fixCount: 2,
      plan: { steps: [] },
      observations: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const out = migrateSession(legacyTask);
    assert.equal(out.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.equal(out.status, "completed");
    assert.equal(out.goal, "create hello.txt");
    assert.equal(out.workspace, "/tmp/project");
    assert.equal(out.trustLevel, "medium");
    assert.deepEqual(out.completionCriteria, []);
    assert.equal("plan" in out, false);
    assert.equal("fixCount" in out, false);
    assert.ok(String(out.id).startsWith("session_"));
  });

  test("unfinished legacy states map to cancelled", () => {
    for (const state of ["READY", "UNDERSTAND", "PLAN", "EXECUTE", "OBSERVE", "FIX"]) {
      const out = migrateSession({ schemaVersion: 3, id: "t", goal: "g", state });
      assert.equal(out.status, "cancelled");
      assert.equal(out.failureReason, "migrated from legacy task state");
    }
  });

  test("stamping writes the current version", () => {
    const stamped = stampSchemaVersion({ id: "s1" });
    assert.equal(stamped.schemaVersion, SESSION_SCHEMA_VERSION);
  });
});
