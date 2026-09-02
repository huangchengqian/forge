import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTask, attachTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime, type FakePlan } from "../runtime/fake-runtime.ts";
import { SkillRegistry } from "../skills/index.ts";
import { saveTask, loadTask } from "../core/persistence/task-store.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import type { TaskSession } from "../core/types/task-session.ts";

const TMP = "/tmp/forge-eval-demo";

async function scenarioNormal(): Promise<{ state: string; evalStatus: string | null }> {
  const taskId = "eval-normal-001";
  const dir = join(TMP, "tasks", taskId);
  await mkdir(dir, { recursive: true });

  const plan: FakePlan = {
    steps: [
      {
        intent: "create util.ts",
        criteria: [
          { kind: "file_exists", path: "util.ts" },
          { kind: "file_contains", path: "util.ts", pattern: "export " },
        ],
      },
    ],
  };
  const fake = new FakeRuntime(TMP, plan);
  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "state_changed") console.log(`    [state] ${e.from} → ${e.to}`);
    if (e.type === "evaluation_completed") {
      console.log(`    [evaluate] ${e.result.status} (score=${e.result.score})`);
      for (const f of e.result.findings) console.log(`      · [${f.severity}] ${f.rule}: ${f.message}`);
    }
  });

  const handle = await startTask({
    runtime: fake,
    taskId,
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus,
    deadlineMs: 30_000,
    policy: undefined,
    skillRegistry: new SkillRegistry(),
    workspace: dir,
  });
  handle.task.goal = "Create a TypeScript utility function";

  await writeFile(join(dir, "util.ts"), "export function util() {}\n", "utf8");

  const final = await runOrchestrator(handle);
  return { state: final.state, evalStatus: final.lastEvaluation?.status ?? null };
}

async function scenarioHeavyRetry(): Promise<{ state: string; evalStatus: string | null }> {
  const taskId = "eval-retry-001";
  const dir = join(TMP, "tasks", taskId);
  await mkdir(dir, { recursive: true });

  const now = Date.now();
  const stepId = "step-1";
  const crafted: TaskSession = {
    id: taskId,
    goal: "fix the broken config",
    state: "EXECUTE",
    plan: {
      id: randomUUID(),
      version: 1,
      objective: "fix the broken config",
      steps: [
        {
          id: stepId,
          intent: "repair config.txt",
          status: "pending",
          attempts: 3,
          dependencies: [],
          executionGroup: undefined,
          successCriteria: [{ kind: "file_exists", path: "config.txt" }],
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    currentStepId: stepId,
    observations: [
      { id: randomUUID(), stepId, result: "FAIL", attempt: 1, criterionResults: [], failureReason: "attempt 1 failed", timestamp: now - 3000 },
      { id: randomUUID(), stepId, result: "FAIL", attempt: 2, criterionResults: [], failureReason: "attempt 2 failed", timestamp: now - 2000 },
      { id: randomUUID(), stepId, result: "FAIL", attempt: 3, criterionResults: [], failureReason: "attempt 3 failed", timestamp: now - 1000 },
    ],
    runtime: null,
    piSessionId: null,
    directory: dir,
    workspacePath: dir,
    projectId: null,
    model: { provider: "fake", modelId: "fake" },
    fixCount: 5,
    createdAt: now,
    updatedAt: now,
    failureReason: null,
    lastEvaluation: null,
  };
  await saveTask(crafted);
  await appendEvent(taskId, "TASK_CREATED", { goal: crafted.goal });
  for (let i = 1; i <= 3; i++) {
    await appendEvent(taskId, "OBSERVATION_CREATED", { attempt: i, result: "FAIL" });
  }

  const fake = new FakeRuntime(TMP, { steps: [] });
  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "state_changed") console.log(`    [state] ${e.from} → ${e.to}`);
    if (e.type === "evaluation_completed") {
      console.log(`    [evaluate] ${e.result.status} (score=${e.result.score})`);
      for (const f of e.result.findings) console.log(`      · [${f.severity}] ${f.rule}: ${f.message}`);
    }
  });

  const handle = await attachTask({
    runtime: fake,
    taskId,
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus,
    deadlineMs: 30_000,
    policy: undefined,
    skillRegistry: new SkillRegistry(),
    workspace: dir,
  });
  if (!handle) throw new Error("attach failed");

  await writeFile(join(dir, "config.txt"), "fixed\n", "utf8");

  const final = await runOrchestrator(handle);
  void (await loadTask(taskId));
  return { state: final.state, evalStatus: final.lastEvaluation?.status ?? null };
}

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");

  console.log("==== Phase 6.4 Self Evaluation Demo ====\n");

  console.log("--- Scenario A: clean task → EVALUATE PASS → COMPLETE ---");
  const a = await scenarioNormal();
  console.log(`    result: state=${a.state}, evaluation=${a.evalStatus}\n`);

  console.log("--- Scenario B: heavy retry history → EVALUATE WARNING ---");
  const b = await scenarioHeavyRetry();
  console.log(`    result: state=${b.state}, evaluation=${b.evalStatus}\n`);

  const ok =
    a.state === "COMPLETE" && a.evalStatus === "PASS" &&
    b.state === "COMPLETE" && b.evalStatus === "WARNING";
  console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
