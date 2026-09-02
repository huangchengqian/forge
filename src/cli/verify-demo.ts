import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import { verifyCriteria } from "../verification/index.ts";
import { SkillRegistry } from "../skills/index.ts";

const TMP = "/tmp/forge-verify-demo";

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");

  const taskDir = join(TMP, "tasks", "verify-demo");
  console.log("==== Phase 5.2 Verification System Demo ====\n");
  console.log(`task dir: ${taskDir}`);

  const fake = new FakeRuntime(TMP, {
    steps: [
      {
        intent: "Create hello.ts with a function returning hello world",
        criteria: [
          { kind: "file_exists", path: "hello.ts" },
          { kind: "file_contains", path: "hello.ts", pattern: "hello world" },
          { kind: "file_not_contains", path: "hello.ts", pattern: "TODO" },
        ],
      },
    ],
  });

  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "state_changed") console.log(`  [state] ${e.from} → ${e.to}`);
    else if (e.type === "step_verified") console.log(`  [verify] step ${e.stepId} PASS`);
    else if (e.type === "fix_started") console.log(`  [fix] ${e.stepId} attempt=${e.attempt} — ${e.reason}`);
    else if (e.type === "completed") console.log(`  [done] COMPLETE`);
  });

  console.log("\n--- Stage 1: direct Verification Engine (multi-criteria) ---");
  const helloPath = join(taskDir, "hello.ts");
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    helloPath,
    `export function hello(): string {\n  return "hello world";\n}\n`,
    "utf8",
  );

  const multiCriteria = [
    { kind: "file_exists", path: "hello.ts" },
    { kind: "file_contains", path: "hello.ts", pattern: "hello world" },
    { kind: "file_not_contains", path: "hello.ts", pattern: "TODO" },
    { kind: "directory_exists", path: "." },
  ] as const;

  const v1 = await verifyCriteria("step-1", multiCriteria, taskDir);
  console.log(`  passed: ${v1.passed}`);
  for (const r of v1.criteriaResults) {
    console.log(`    [${r.passed ? "PASS" : "FAIL"}] ${r.criterion.kind} — ${r.message}`);
  }
  console.log(`  metadata: ${JSON.stringify(v1.metadata)}`);

  console.log("\n--- Stage 2: negative case (file_not_contains fail) ---");
  await writeFile(helloPath, "export function hello() { return 42; }\n", "utf8");
  const v2 = await verifyCriteria(
    "step-1",
    [
      { kind: "file_contains", path: "hello.ts", pattern: "hello world" },
      { kind: "file_not_contains", path: "hello.ts", pattern: "42" },
    ],
    taskDir,
  );
  console.log(`  passed: ${v2.passed}`);
  for (const r of v2.failed) {
    console.log(`    [FAIL] ${r.criterion.kind} — ${r.message}`);
  }

  console.log("\n--- Stage 3: git_diff_contains (requires git repo) ---");
  const v3 = await verifyCriteria("step-1", [{ kind: "git_diff_contains", pattern: "hello" }], taskDir);
  console.log(`  passed: ${v3.passed} — ${v3.failed[0]?.message ?? "no failure"}`);

  console.log("\n--- Stage 4: command_exit_zero ---");
  const v4 = await verifyCriteria("step-1", [{ kind: "command_exit_zero", command: "node -e 'console.log(1+1)'" }], taskDir);
  console.log(`  passed: ${v4.passed} — ${v4.criteriaResults[0]?.message}`);

  console.log("\n--- Stage 5: Full Orchestrator lifecycle with multi-criteria plan ---");
  await writeFile(
    helloPath,
    `export function hello(): string {\n  return "hello world";\n}\n`,
    "utf8",
  );
  const handle = await startTask({
    runtime: fake,
    taskId: "verify-demo",
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus,
    deadlineMs: 30_000,
    policy: undefined,
    skillRegistry: new SkillRegistry(),
    workspace: taskDir,
  });
  handle.task.goal = "Create hello.ts with a function returning hello world";
  const final = await runOrchestrator(handle);
  console.log(`\n  final state: ${final.state}`);
  console.log(`  observations: ${final.observations.length}`);
  for (const o of final.observations) {
    console.log(`    [${o.result}] ${o.stepId} attempt=${o.attempt}`);
    for (const cr of o.criterionResults) {
      console.log(`      · ${cr.criterion.kind}: ${cr.message}`);
    }
  }

  const ok = final.state === "COMPLETE" && v1.passed && !v2.passed && v4.passed;
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
