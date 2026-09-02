import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime, type FakePlan } from "../runtime/fake-runtime.ts";
import { TaskRecoveryService } from "../recovery/index.ts";
import { SkillRegistry } from "../skills/index.ts";
import { loadTask } from "../core/persistence/task-store.ts";
import { appendEvent, readEvents } from "../core/persistence/event-log.ts";
import { saveTask } from "../core/persistence/task-store.ts";
import type { TaskSession } from "../core/types/task-session.ts";

const TMP = "/tmp/forge-crash-demo";
const TASK_ID = "crash-task-001";

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");

  const taskDir = join(TMP, "tasks", TASK_ID);
  const plan: FakePlan = {
    steps: [
      {
        intent: "create crash.txt",
        criteria: [
          { kind: "file_exists", path: "crash.txt" },
          { kind: "file_contains", path: "crash.txt", pattern: "recovered" },
        ],
      },
    ],
  };

  console.log("==== Phase 5.3 Crash Recovery Demo ====\n");

  console.log("--- Phase 1: task created, crashes mid-EXECUTE ---");
  await mkdir(taskDir, { recursive: true });
  const now = Date.now();
  const crashedTask: TaskSession = {
    id: TASK_ID,
    goal: "create crash.txt with recovered content",
    state: "EXECUTE",
    plan: {
      id: "plan-1",
      version: 1,
      objective: "create crash.txt with recovered content",
      steps: [
        {
          id: "step-1",
          intent: "create crash.txt with recovered content",
          status: "running",
          attempts: 1,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [
            { kind: "file_exists", path: "crash.txt" },
            { kind: "file_contains", path: "crash.txt", pattern: "recovered" },
          ],
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    currentStepId: "step-1",
    observations: [],
    runtime: null,
    piSessionId: null,
    directory: taskDir,
    workspacePath: taskDir,
    projectId: null,
    model: { provider: "fake", modelId: "fake" },
    fixCount: 0,
    createdAt: now,
    updatedAt: now,
    lastEvaluation: null,
    failureReason: null,
  };
  await saveTask(crashedTask);
  await appendEvent(TASK_ID, "TASK_CREATED", { goal: crashedTask.goal });
  await appendEvent(TASK_ID, "STATE_CHANGED", { from: "READY", to: "EXECUTE" });
  await appendEvent(TASK_ID, "STEP_STARTED", { stepId: "step-1", attempt: 1 });
  console.log(`  [CRASH] process terminated mid-EXECUTE (task JSON remains)`);
  const crashed = await loadTask(TASK_ID);
  console.log(`  persisted state at crash: ${crashed?.state}`);
  console.log(`  persisted currentStepId: ${crashed?.currentStepId}`);
  console.log(`  persisted runtime: ${JSON.stringify(crashed?.runtime)}`);

  console.log("\n--- Phase 2: process restarts, recovery service inspects ---");
  const recovery = new TaskRecoveryService();
  const decision = await recovery.inspect(TASK_ID);
  console.log(`  decision kind: ${decision.kind}`);
  if (decision.kind !== "recoverable") throw new Error(`unexpected: ${JSON.stringify(decision)}`);
  console.log(`  reason: ${decision.reason}`);

  const planRecovery = await recovery.plan(TASK_ID);
  console.log(`  resumeFrom: ${planRecovery?.resumeFrom}`);
  console.log(`  runtimeSessionLost: ${planRecovery?.runtimeSessionLost}`);
  console.log(`  persisted events: ${planRecovery?.events.length}`);
  for (const e of planRecovery?.events ?? []) {
    console.log(`    · ${e.type} @ ${new Date(e.at).toISOString()}`);
  }

  console.log("\n--- Phase 3: resume execution (new runtime session) ---");
  const fake2 = new FakeRuntime(TMP, plan);
  const bus2 = new EventBus();
  bus2.subscribe((e) => {
    if (e.type === "state_changed") console.log(`  [${fake2.constructor.name}] ${e.from} → ${e.to}`);
    if (e.type === "completed") console.log(`  [completed] TASK COMPLETE`);
  });
  const h2 = await attachTask({
    runtime: fake2,
    taskId: TASK_ID,
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus2,
    deadlineMs: 30_000,
    policy: undefined,
    skillRegistry: new SkillRegistry(),
  });
  if (!h2) throw new Error("attach failed");
  console.log(`  new runtime session id: ${h2.session.id} (differs from crashed one)`);

  // The file may not exist after crash; create it to let OBSERVE pass.
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "crash.txt"), "recovered content\n", "utf8");

  const final = await runOrchestrator(h2);

  console.log("\n--- Phase 4: verify recovery ---");
  console.log(`  final state: ${final.state}`);
  console.log(`  observations: ${final.observations.length}`);
  for (const o of final.observations) {
    console.log(`    [${o.result}] ${o.stepId} attempt=${o.attempt}`);
    for (const cr of o.criterionResults) {
      console.log(`      · ${cr.criterion.kind}: ${cr.message}`);
    }
  }
  const events = await readEvents(TASK_ID);
  console.log(`  total persisted events: ${events.length}`);
  for (const e of events) {
    console.log(`    · ${e.type}`);
  }

  const ok =
    final.state === "COMPLETE" &&
    decision.kind === "recoverable" &&
    planRecovery?.runtimeSessionLost === true &&
    h2.session.id.startsWith("fake-") &&
    events.some((e) => e.type === "TASK_CREATED") &&
    events.some((e) => e.type === "TASK_COMPLETED");
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
