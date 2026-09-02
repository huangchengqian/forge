import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { migrateTask, stampSchemaVersion, TASK_SCHEMA_VERSION } from "./schema.ts";

const BASE = { id: "t1", goal: "g", state: "EXECUTE", directory: "/d" };

describe("task schema migrations", () => {
  test("current version is 3", () => {
    assert.equal(TASK_SCHEMA_VERSION, 3);
  });

  test("stamp writes schemaVersion 3", () => {
    const stamped = stampSchemaVersion({ ...BASE });
    assert.equal(stamped.schemaVersion, 3);
  });

  test("v2 → v3 backfills workspacePath/projectId as null", () => {
    const migrated = migrateTask({ ...BASE, schemaVersion: 2 });
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.workspacePath, null);
    assert.equal(migrated.projectId, null);
  });

  test("v2 → v3 preserves existing v3 fields", () => {
    const migrated = migrateTask({
      ...BASE,
      schemaVersion: 2,
      workspacePath: "/project",
      projectId: "prj_1",
    });
    assert.equal(migrated.workspacePath, "/project");
    assert.equal(migrated.projectId, "prj_1");
  });

  test("v1 → v3 chain (via v2) lands on v3 with all fields", () => {
    const migrated = migrateTask({ ...BASE, fixCount: 7 });
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.fixCount, 7);
    assert.equal(migrated.currentStepId, null);
    assert.equal(migrated.runtime, null);
    assert.equal(migrated.workspacePath, null);
    assert.equal(migrated.projectId, null);
  });

  test("unversioned legacy (v0) reaches v3", () => {
    const migrated = migrateTask({ ...BASE });
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.fixCount, 0);
    assert.equal(migrated.workspacePath, null);
    assert.equal(migrated.projectId, null);
  });

  test("already v3 passes through unchanged", () => {
    const migrated = migrateTask({ ...BASE, schemaVersion: 3, workspacePath: "/p", projectId: "prj_x" });
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.workspacePath, "/p");
    assert.equal(migrated.projectId, "prj_x");
  });
});
