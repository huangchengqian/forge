import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import type { Planner, TaskContext, CreatePlanResult, UpdatePlanResult } from "../orchestrator/planner.ts";
import { applyPlanOps, newStep } from "../orchestrator/plan-ops.ts";
import type { Plan } from "../core/types/plan.ts";
import type { Observation } from "../core/types/step.ts";

const TMP = "/tmp/forge-dynplan-demo";
const TASK_ID = "dynplan-task-001";

class DynamicPlanner implements Planner {
  constructor(private readonly taskDir: string) {}

  async createPlan(_ctx: TaskContext): Promise<CreatePlanResult> {
    const now = Date.now();
    const plan: Plan = {
      id: randomUUID(),
      version: 1,
      objective: "Create API and test it",
      steps: [
        newStep("step-1", "create api.ts", [
          { kind: "file_exists", path: "api.ts" },
          { kind: "file_contains", path: "api.ts", pattern: "export function api" },
        ]),
      ],
      createdAt: now,
      updatedAt: now,
    };
    return { plan, source: "llm", appliedSkills: [] };
  }

  async updatePlan(_ctx: TaskContext, observation: Observation): Promise<UpdatePlanResult> {
    if (observation.result !== "PASS") return null;
    if (observation.stepId !== "step-1") return null;

    const plan = _ctx.task.plan;
    if (!plan || plan.version >= 2) return null;

    // After step-1 passes, we discover a config is needed. Add step-2.
    const { plan: revised } = applyPlanOps(plan, [
      {
        op: "add",
        step: newStep("step-2", "create config.json", [
          { kind: "file_exists", path: "config.json" },
          { kind: "file_contains", path: "config.json", pattern: "port" },
        ]),
      },
    ]);
    return { plan: revised, changed: true };
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
  console.log("==== Phase 6.1 Dynamic Planner Demo ====\n");
  console.log(`task dir: ${taskDir}`);

  const fake = new FakeRuntime(TMP, { steps: [] });
  const planner = new DynamicPlanner(taskDir);

  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "state_changed") console.log(`  [state] ${e.from} → ${e.to}`);
    if (e.type === "plan_created") console.log(`  [plan] created v${e.plan.version} (${e.plan.steps.length} step(s), source=${e.source})`);
    if (e.type === "plan_revised") {
      console.log(`  [plan] REVISED v${e.plan.version} (${e.plan.steps.length} step(s), ${e.ops.length} op(s))`);
      for (const op of e.ops) {
        if (op.op === "add") console.log(`    + add step "${op.step.intent}"`);
        if (op.op === "remove") console.log(`    - remove step ${op.stepId}`);
      }
    }
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
    workspace: taskDir,
  });
  handle.task.goal = "Create API and test it";

  // Simulate runtime writing files between EXECUTE and OBSERVE.
  // step-1 writes api.ts; step-2 writes config.json.
  const origPrompt = fake.prompt.bind(fake);
  fake.prompt = async (session, message, opts) => {
    const r = await origPrompt(session, message, opts);
    if (message.includes("create api.ts")) {
      await writeFile(join(taskDir, "api.ts"), 'export function api() { return "ok"; }\n', "utf8");
    }
    if (message.includes("create config.json")) {
      await writeFile(join(taskDir, "config.json"), '{ "port": 8080 }\n', "utf8");
    }
    return r;
  };

  const final = await runOrchestrator(handle);

  console.log("\n--- Final Plan ---");
  if (final.plan) {
    console.log(`  version: ${final.plan.version}`);
    for (const s of final.plan.steps) {
      console.log(`  [${s.status}] ${s.id}: ${s.intent}`);
    }
  }
  console.log(`final state: ${final.state}`);
  console.log(`observations: ${final.observations.length}`);
  for (const o of final.observations) {
    console.log(`  [${o.result}] ${o.stepId} attempt=${o.attempt}`);
  }

  const ok =
    final.state === "COMPLETE" &&
    final.plan?.version === 2 &&
    final.plan.steps.length === 2 &&
    final.plan.steps.every((s) => s.status === "verified");
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
