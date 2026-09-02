import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_RETRY_POLICY,
  decideFix,
} from "../orchestrator/index.ts";
import { saveTask } from "../core/persistence/task-store.ts";
import { validate } from "../verification/index.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { Plan } from "../core/types/plan.ts";
import type { Observation, PlanStep } from "../core/types/step.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

const FORGE_HOME = "/tmp/forge-phase2-demo";
const TASK_ID = "task_20260823_phase2";

async function main() {
  await rm(FORGE_HOME, { recursive: true, force: true });
  await mkdir(FORGE_HOME, { recursive: true });
  const taskDir = join(FORGE_HOME, "tasks", TASK_ID);
  await mkdir(taskDir, { recursive: true });

  console.log("==== Phase 2 FIX + Retry Demo ====\n");
  console.log(`task dir: ${taskDir}`);

  const now = Date.now();
  const correctCriterion: SuccessCriterion = {
    kind: "command_exit_zero",
    command: `bash -c 'test -f "${taskDir}/hello.txt" && grep -q "forge-e2e-ok" "${taskDir}/hello.txt"'`,
  };
  const wrongCriterion: SuccessCriterion = {
    kind: "command_exit_zero",
    command: `bash -c 'test -f "${taskDir}/hello.txt" && grep -q "wrong-content" "${taskDir}/hello.txt"'`,
  };

  let task: TaskSession = {
    id: TASK_ID,
    goal: "create hello.txt with forge-e2e-ok",
    state: "OBSERVE",
    plan: null,
    currentStepId: null,
    observations: [],
    piSessionId: "fake-pi-session",
    directory: taskDir,
    workspacePath: taskDir,
    projectId: null,
    model: { provider: "demo", modelId: "demo" },
    runtime: null,
    fixCount: 0,
    createdAt: now,
    updatedAt: now,
    lastEvaluation: null,
    failureReason: null,
  };

  const step: PlanStep = {
    id: "step-1",
    intent: "create hello.txt with forge-e2e-ok",
    status: "running",
    attempts: 1,
    successCriteria: [wrongCriterion],
    dependencies: [],
    executionGroup: undefined,
  };
  const plan: Plan = {
    id: randomUUID(),
    version: 1,
    objective: task.goal,
    steps: [step],
    createdAt: now,
    updatedAt: now,
  };
  task = { ...task, plan };
  await saveTask(task);

  console.log("\n--- attempt 1: simulate EXECUTE (write hello.txt) + OBSERVE (grep wrong-content) ---");
  await writeFile(join(taskDir, "hello.txt"), "forge-e2e-ok\n", "utf8");
  console.log(`  wrote: ${join(taskDir, "hello.txt")}`);

  const wrongResults = [];
  for (const c of step.successCriteria) {
    wrongResults.push(await validate(c, task.directory));
  }
  const allSelected = wrongResults.every((r) => r.passed);
  const firstObsId = randomUUID();
  const observation1 = {
    id: firstObsId,
    stepId: step.id,
    result: allSelected ? "PASS" : "FAIL",
    attempt: step.attempts,
    criterionResults: wrongResults,
    failureReason: allSelected
      ? undefined
      : wrongResults.filter((r) => !r.passed).map((r) => `${r.criterion.kind}: ${r.message}`).join("; "),
    timestamp: Date.now(),
  } as const;
  task = {
    ...task,
    observations: [...task.observations, observation1],
    plan: { ...plan, steps: [{ ...step, status: allSelected ? "verified" : "failed" }] },
  };
  await saveTask(task);
  console.log(`  observation: result=${observation1.result}, reason=${observation1.failureReason ?? "(none)"}`);

  console.log("\n--- OBSERVE FAIL → FIX ---");
  const lastFail: Observation | undefined = task.observations[task.observations.length - 1];
  if (!lastFail) throw new Error("no observation");
  const targetStep = task.plan!.steps[0];
  if (!targetStep) throw new Error("no step");
  const action = decideFix(targetStep, lastFail, task.directory);
  console.log(`  fix prompt hint:\n${action.promptHint.split("\n").map((l) => `    ${l}`).join("\n")}`);
  console.log(`  rewritten criteria command:`);
  for (const c of action.rewrittenCriteria) {
    if (c.kind === "command_exit_zero") {
      console.log(`    ${c.command}`);
    }
  }

  console.log("\n--- attempt 2: re-EXECUTE (idempotent) + OBSERVE (grep forge-e2e-ok) ---");
  task = {
    ...task,
    state: "FIX",
    plan: {
      ...plan,
      steps: [{ ...step, status: "pending", successCriteria: action.rewrittenCriteria }],
    },
    fixCount: task.fixCount + 1,
    updatedAt: Date.now(),
  };
  await saveTask(task);

  const rewrittenStep = task.plan!.steps[0]!;
  const fixedResults = [];
  for (const c of rewrittenStep.successCriteria) {
    fixedResults.push(await validate(c, task.directory));
  }
  const allPassed = fixedResults.every((r) => r.passed);
  const observation2 = {
    id: randomUUID(),
    stepId: rewrittenStep.id,
    result: allPassed ? "PASS" : "FAIL",
    attempt: rewrittenStep.attempts + 1,
    criterionResults: fixedResults,
    failureReason: allPassed ? undefined : fixedResults.filter((r) => !r.passed).map((r) => r.message).join("; "),
    timestamp: Date.now(),
  } as const;
  task = {
    ...task,
    state: allPassed ? "COMPLETE" : "FAILED",
    observations: [...task.observations, observation2],
    plan: {
      ...task.plan!,
      steps: [{ ...rewrittenStep, status: allPassed ? "verified" : "failed" }],
    },
    failureReason: allPassed ? null : observation2.failureReason ?? "unknown",
    fixCount: task.fixCount,
    updatedAt: Date.now(),
  };
  await saveTask(task);

  console.log(`  observation: result=${observation2.result}, reason=${observation2.failureReason ?? "(none)"}`);
  console.log(`  fixCount: ${task.fixCount}`);
  console.log(`  task state: ${task.state}`);
  console.log(`\n==== Final Task ====`);
  console.log(JSON.stringify({
    id: task.id,
    state: task.state,
    fixCount: task.fixCount,
    observations: task.observations.map((o) => ({
      stepId: o.stepId,
      attempt: o.attempt,
      result: o.result,
      failureReason: o.failureReason,
    })),
  }, null, 2));

  if (task.state !== "COMPLETE") {
    console.error(`\nFAIL: expected COMPLETE, got ${task.state}`);
    process.exit(1);
  }

  void DEFAULT_RETRY_POLICY;
  console.log(`\nPersistence file: ${join(FORGE_HOME, "tasks", TASK_ID + ".json")}`);
  console.log("forge-e2e-ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
