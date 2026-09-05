import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = "/tmp/forge-engine-tests";
process.env.FORGE_HOME = TMP;
process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
process.env.FORGE_EVENTS_DIR = join(TMP, "events");
process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");

const { FakeRuntime } = await import("../runtime/fake-runtime.ts");
const { startTask, runOrchestrator } = await import("./engine.ts");

test("execution budget and retry policy survive startTask into the runtime handle", async () => {
  await rm(TMP, { recursive: true, force: true });
  const runtime = new FakeRuntime(TMP, {
    steps: [{ intent: "do nothing", criteria: [{ kind: "file_exists", path: "never-created.txt" }] }],
  });
  const handle = await startTask({
    runtime,
    taskId: "budget-policy",
    provider: "fake",
    modelId: "fake",
    env: {},
    eventBus: undefined,
    deadlineMs: 45_000,
    policy: { maxFixesPerTask: 0, maxAttemptsPerStep: 1 },
    workspace: join(TMP, "workspace"),
  });
  handle.task.goal = "exercise configured policy";
  assert.equal(handle.deadlineMs, 45_000);
  assert.equal(handle.policy?.maxFixesPerTask, 0);

  const final = await runOrchestrator(handle);
  assert.equal(final.state, "FAILED");
  assert.equal(final.fixCount, 0);
  assert.match(final.failureReason ?? "", /task_fix_budget_exhausted/);
});
