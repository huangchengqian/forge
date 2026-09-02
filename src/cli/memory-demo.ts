import { mkdir, rm } from "node:fs/promises";
import { retrieve, addMemory, extractFromTask, listMemory, clearMemory } from "../memory/index.ts";
import { saveTask } from "../core/persistence/task-store.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { Plan } from "../core/types/plan.ts";
import type { PlanStep, Observation } from "../core/types/step.ts";
import type { CriterionResult } from "../core/types/criterion.ts";
import { validate } from "../verification/index.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MEMORY_PATH = "/tmp/forge-phase3-demo-memory.json";
const TASK_A_DIR = "/tmp/forge-phase3-demo/task-A";
const TASK_B_DIR = "/tmp/forge-phase3-demo/task-B";

async function main() {
  await rm("/tmp/forge-phase3-demo", { recursive: true, force: true });
  await rm(MEMORY_PATH, { force: true });

  process.env.FORGE_MEMORY_PATH = MEMORY_PATH;

  console.log("==== Phase 3 Engineering Memory Demo ====\n");
  console.log(`memory file: ${MEMORY_PATH}`);
  console.log(`task A dir: ${TASK_A_DIR}`);
  console.log(`task B dir: ${TASK_B_DIR}\n`);

  console.log("=== STAGE 1: Task A completes (postgres task) ===\n");
  const taskA = await buildAndSaveTask(
    "task_A_postgres",
    "add user table to postgres database",
    TASK_A_DIR,
    true,
  );
  const extractedA = await extractFromTask(taskA);
  console.log(`  task A state: ${taskA.state}`);
  console.log(`  extracted ${extractedA.length} fact(s):`);
  for (const it of extractedA) {
    console.log(`    · [${it.type}] (conf=${it.confidence}) ${it.content}`);
    console.log(`      keywords: ${it.keywords.join(", ")}`);
  }

  console.log("\n=== STAGE 2: Memory store after Task A ===\n");
  const allAfterA = await listMemory();
  console.log(`  items in memory: ${allAfterA.length}`);
  for (const it of allAfterA) {
    console.log(`    - [${it.type}] ${it.content}`);
  }

  console.log("\n=== STAGE 3: Task B starts (different postgres task) ===\n");
  console.log("  query: \"modify postgres schema for orders table\"");
  const retrievedB = await retrieve({
    query: "modify postgres schema for orders table",
    types: undefined,
    maxResults: 5,
    minConfidence: 0.5,
  });
  console.log(`  retrieved ${retrievedB.length} item(s):`);
  for (const r of retrievedB) {
    console.log(`    · score=${r.score.toFixed(2)} [${r.item.type}] ${r.item.content}`);
    console.log(`      matched: ${r.matchedKeywords.join(", ")}`);
  }

  console.log("\n=== STAGE 4: Task A fails repeatedly (failure pattern extraction) ===\n");
  const taskAFail = await buildAndSaveTask(
    "task_A_postgres_failed",
    "add user table to postgres database",
    TASK_A_DIR,
    false,
  );
  const extractedFail = await extractFromTask(taskAFail);
  console.log(`  task A state: ${taskAFail.state}`);
  console.log(`  extracted ${extractedFail.length} fact(s):`);
  for (const it of extractedFail) {
    console.log(`    · [${it.type}] (conf=${it.confidence}) ${it.content}`);
  }

  console.log("\n=== STAGE 5: Retrieve FAILURE_PATTERN by failure-related query ===\n");
  const failSearch = await retrieve({
    query: "postgres user table failure",
    types: ["FAILURE_PATTERN"],
    maxResults: 5,
    minConfidence: 0.5,
  });
  console.log(`  retrieved ${failSearch.length} FAILURE_PATTERN item(s):`);
  for (const r of failSearch) {
    console.log(`    · [${r.item.type}] ${r.item.content}`);
  }

  console.log("\n=== STAGE 6: Type filter ===\n");
  const onlyFacts = await retrieve({
    query: "postgres schema",
    types: ["PROJECT_FACT"],
    maxResults: 5,
    minConfidence: 0.5,
  });
  console.log(`  PROJECT_FACT only: ${onlyFacts.length} item(s)`);
  for (const r of onlyFacts) {
    console.log(`    · ${r.item.content}`);
  }

  console.log("\n==== Final Memory State ====");
  const finalAll = await listMemory();
  console.log(`total items: ${finalAll.length}`);
  for (const it of finalAll) {
    console.log(`  - [${it.type}] conf=${it.confidence} src=${it.source} refs=${it.taskRefs.join(",")} :: ${it.content}`);
  }

  await clearMemory();
  await rm(MEMORY_PATH, { force: true });
  console.log("\ncleanup done");
}

async function buildAndSaveTask(
  id: string,
  goal: string,
  dir: string,
  succeeded: boolean,
): Promise<TaskSession> {
  const now = Date.now();
  await mkdir(dir, { recursive: true });
  const stepId = "step-1";
  const step: PlanStep = {
    id: stepId,
    intent: goal,
    status: succeeded ? "verified" : "failed",
    attempts: succeeded ? 1 : 3,
    successCriteria: succeeded
      ? [{ kind: "command_exit_zero", command: "bash -c 'true'" }]
      : [{ kind: "command_exit_zero", command: `bash -c 'test -f "${dir}/schema.sql"'` }],
    dependencies: [],
    executionGroup: undefined,
  };
  const plan: Plan = {
    id: randomUUID(),
    version: 1,
    objective: goal,
    steps: [step],
    createdAt: now,
    updatedAt: now,
  };

  const results: CriterionResult[] = [];
  for (const c of step.successCriteria) {
    results.push(await validate(c, dir));
  }
  const passed = results.every((r) => r.passed);
  const failed = results.filter((r) => !r.passed);
  const observation: Observation = {
    id: randomUUID(),
    stepId,
    result: succeeded && passed ? "PASS" : "FAIL",
    attempt: step.attempts,
    criterionResults: results,
    failureReason: failed.length > 0 ? failed.map((r) => r.message).join("; ") : undefined,
    timestamp: now,
  };

  const task: TaskSession = {
    id,
    goal,
    state: succeeded ? "COMPLETE" : "FAILED",
    plan,
    currentStepId: stepId,
    observations: succeeded
      ? [observation]
      : [
          { ...observation, id: randomUUID(), result: "FAIL", failureReason: "initial attempt failed" },
          { ...observation, id: randomUUID(), result: "FAIL", failureReason: "second attempt failed" },
          observation,
        ],
    piSessionId: "demo",
    directory: dir,
    workspacePath: dir,
    projectId: null,
    model: { provider: "demo", modelId: "demo" },
    runtime: null,
    fixCount: succeeded ? 0 : 10,
    createdAt: now,
    updatedAt: now,
    lastEvaluation: null,
    failureReason: succeeded ? null : "budget exhausted",
  };
  await saveTask(task);
  return task;
}

void join;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
