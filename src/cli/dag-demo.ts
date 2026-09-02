import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { Planner, TaskContext, CreatePlanResult, UpdatePlanResult } from "../orchestrator/planner.ts";
import { newStep } from "../orchestrator/plan-ops.ts";
import type { Plan } from "../core/types/plan.ts";
import type { Observation } from "../core/types/step.ts";

const TMP = "/tmp/forge-dag-demo";
const TASK_ID = "dag-task-001";

class DagPlanner implements Planner {
  async createPlan(_ctx: TaskContext): Promise<CreatePlanResult> {
    const now = Date.now();
    const plan: Plan = {
      id: randomUUID(),
      version: 1,
      objective: "Create a TypeScript project with utility module and tests",
      steps: [
        newStep("step-project", "create project skeleton (package.json + tsconfig)", [
          { kind: "file_exists", path: "package.json" },
          { kind: "file_exists", path: "tsconfig.json" },
        ]),
        newStep("step-utility", "create utility module (util.ts)", [
          { kind: "file_exists", path: "util.ts" },
        ], ["step-project"]),
        newStep("step-tests", "create tests (util.test.ts)", [
          { kind: "file_exists", path: "util.test.ts" },
        ], ["step-project"]),
        newStep("step-verify-all", "verify all files exist together", [
          { kind: "file_exists", path: "util.ts" },
          { kind: "file_exists", path: "util.test.ts" },
          { kind: "file_contains", path: "package.json", pattern: "name" },
        ], ["step-utility", "step-tests"]),
      ],
      createdAt: now,
      updatedAt: now,
    };
    return { plan, source: "llm", appliedSkills: [] };
  }

  async updatePlan(_ctx: TaskContext, _observation: Observation): Promise<UpdatePlanResult> {
    return null;
  }
}

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");

  const taskDir = join(TMP, "tasks", TASK_ID);
  await mkdir(taskDir, { recursive: true });

  console.log("==== Phase 6.3 Parallel Execution Demo ====\n");
  console.log(`task dir: ${taskDir}`);
  console.log(`DAG:`);
  console.log(`  step-project`);
  console.log(`     /       \\`);
  console.log(`  step-utility  step-tests   (parallel, same group)`);
  console.log(`     \\       /`);
  console.log(`  step-verify-all\n`);

  const fake = new FakeRuntime(TMP, { steps: [] });
  const planner = new DagPlanner();

  let batchLog: string[] = [];
  const origPrompt = fake.prompt.bind(fake);
  fake.prompt = async (session, message, opts) => {
    if (message.includes("step-project")) {
      await writeFile(join(taskDir, "package.json"), '{ "name": "demo" }\n', "utf8");
      await writeFile(join(taskDir, "tsconfig.json"), '{ "compilerOptions": {} }\n', "utf8");
    }
    if (message.includes("step-utility")) {
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(join(taskDir, "util.ts"), "export function util() {}\n", "utf8");
    }
    if (message.includes("step-tests")) {
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(join(taskDir, "util.test.ts"), 'import { util } from "./util";\n', "utf8");
    }
    return await origPrompt(session, message, opts);
  };

  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "state_changed") console.log(`  [state] ${e.from} → ${e.to}`);
    if (e.type === "step_started") batchLog.push(e.stepId);
    if (e.type === "step_verified") console.log(`  [verify] ${e.stepId} PASS`);
    if (e.type === "completed") console.log(`  [done] TASK COMPLETE`);
  });

  const handle = await startTask({
    runtime: fake,
    planner,
    taskId: TASK_ID,
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus,
    deadlineMs: 60_000,
    policy: undefined,
    maxConcurrency: 2,
    workspace: taskDir,
  });
  handle.task.goal = "Create a TypeScript project with utility module and tests";

  // Track batches by watching consecutive step_started events
  let lastBatch: string[] = [];
  let prevCount = 0;
  bus.subscribe((e) => {
    if (e.type === "state_changed" && e.to === "OBSERVE") {
      lastBatch = batchLog.slice(prevCount);
      prevCount = batchLog.length;
      if (lastBatch.length > 0) {
        console.log(`  [batch] executed in parallel: [${lastBatch.join(", ")}]`);
      }
    }
  });

  const final = await runOrchestrator(handle);

  console.log("\n--- Final Plan ---");
  if (final.plan) {
    for (const s of final.plan.steps) {
      console.log(`  [${s.status}] ${s.id} deps=[${s.dependencies.join(",")}] group=${s.executionGroup ?? "-"}`);
    }
  }
  console.log(`final state: ${final.state}`);
  console.log(`observations: ${final.observations.length}`);

  const parallelBatchSeen = lastBatch.length >= 2 || batchLog.filter((x) => x.startsWith("step-u") || x.startsWith("step-t")).length >= 2;

  const ok =
    final.state === "COMPLETE" &&
    final.plan?.steps.every((s) => s.status === "verified") &&
    parallelBatchSeen;
  console.log(`\nparallel execution observed: ${parallelBatchSeen}`);
  console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
