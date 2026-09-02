import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { saveTask, loadTask, listTasks } from "../core/persistence/task-store.ts";
import { appendEvent, readEvents } from "../core/persistence/event-log.ts";
import { TaskRecoveryService } from "../recovery/index.ts";
import type { TaskSession } from "../core/types/task-session.ts";

const TMP = "/tmp/forge-recovery-tests";

before(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function makeTask(id: string, state: TaskSession["state"]): TaskSession {
  const now = Date.now();
  return {
    id,
    goal: `goal for ${id}`,
    state,
    plan: null,
    currentStepId: null,
    observations: [],
    runtime: state === "READY" ? null : { id: "rt-1", directory: join(TMP, "tasks", id), createdAt: now, modelProvider: "fake", modelId: "fake" },
    piSessionId: state === "READY" ? null : "pi-1",
    directory: join(TMP, "tasks", id),
    workspacePath: join(TMP, "tasks", id),
    projectId: null,
    model: { provider: "fake", modelId: "fake" },
    fixCount: 0,
    createdAt: now,
    updatedAt: now,
    lastEvaluation: null,
    failureReason: null,
  };
}

describe("TaskSession persistence", () => {
  test("save and load round-trips all fields", async () => {
    const task = makeTask("rt-1", "EXECUTE");
    await saveTask(task);
    const loaded = await loadTask("rt-1");
    assert.ok(loaded);
    assert.equal(loaded.id, "rt-1");
    assert.equal(loaded.state, "EXECUTE");
    assert.equal(loaded.currentStepId, null);
    assert.equal(loaded.fixCount, 0);
    assert.equal(loaded.runtime?.id, "rt-1");
    assert.equal(loaded.directory, task.directory);
  });

  test("load missing task returns null", async () => {
    const t = await loadTask("rt-missing");
    assert.equal(t, null);
  });

  test("list returns saved tasks", async () => {
    await saveTask(makeTask("rt-2", "PLAN"));
    const tasks = await listTasks();
    assert.ok(tasks.some((t) => t.id === "rt-2"));
  });
});

describe("Event persistence", () => {
  test("append is append-only and preserves order", async () => {
    await appendEvent("evt-1", "TASK_CREATED", {});
    await appendEvent("evt-1", "STATE_CHANGED", { from: "READY", to: "UNDERSTAND" });
    await appendEvent("evt-1", "TASK_COMPLETED", {});
    const events = await readEvents("evt-1");
    assert.equal(events.length, 3);
    assert.equal(events[0]?.type, "TASK_CREATED");
    assert.equal(events[1]?.type, "STATE_CHANGED");
    assert.equal(events[2]?.type, "TASK_COMPLETED");
    assert.ok(events.every((e) => typeof e.id === "string" && typeof e.at === "number"));
  });

  test("read missing task returns empty", async () => {
    const events = await readEvents("evt-missing");
    assert.equal(events.length, 0);
  });
});

describe("TaskRecoveryService", () => {
  test("inspect recoverable task", async () => {
    await saveTask(makeTask("rec-1", "EXECUTE"));
    const svc = new TaskRecoveryService();
    const d = await svc.inspect("rec-1");
    assert.equal(d.kind, "recoverable");
  });

  test("inspect completed task → already_completed", async () => {
    await saveTask(makeTask("rec-2", "COMPLETE"));
    const svc = new TaskRecoveryService();
    const d = await svc.inspect("rec-2");
    assert.equal(d.kind, "already_completed");
  });

  test("inspect failed task → failed", async () => {
    const t = makeTask("rec-3", "FAILED");
    t.failureReason = "budget exhausted";
    await saveTask(t);
    const svc = new TaskRecoveryService();
    const d = await svc.inspect("rec-3");
    assert.equal(d.kind, "failed");
  });

  test("inspect missing task → not_found", async () => {
    const svc = new TaskRecoveryService();
    const d = await svc.inspect("rec-missing");
    assert.equal(d.kind, "not_found");
  });

  test("plan exposes resumeFrom + runtimeSessionLost", async () => {
    const t = makeTask("rec-4", "EXECUTE");
    t.currentStepId = "step-1";
    await saveTask(t);
    await appendEvent("rec-4", "STATE_CHANGED", { from: "READY", to: "EXECUTE" });

    const svc = new TaskRecoveryService();
    const plan = await svc.plan("rec-4");
    assert.ok(plan);
    assert.equal(plan.resumeFrom, "step-1");
    assert.equal(plan.runtimeSessionLost, false);
    assert.equal(plan.events.length, 1);
  });

  test("plan for completed task returns null", async () => {
    await saveTask(makeTask("rec-5", "COMPLETE"));
    const svc = new TaskRecoveryService();
    const plan = await svc.plan("rec-5");
    assert.equal(plan, null);
  });
});
