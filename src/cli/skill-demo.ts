import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";

const TMP = "/tmp/forge-skill-demo";
const TASK_ID = "skill-task-001";

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");

  const taskDir = join(TMP, "tasks", TASK_ID);
  await mkdir(taskDir, { recursive: true });

  console.log("==== Phase 6.2 Skill System Demo ====\n");
  console.log(`task dir: ${taskDir}`);
  console.log(`goal: "Create a TypeScript utility function"\n`);

  const fake = new FakeRuntime(TMP, { steps: [] });

  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.type === "state_changed") console.log(`  [state] ${e.from} → ${e.to}`);
    if (e.type === "plan_created") {
      console.log(`  [plan] created v${e.plan.version} (${e.plan.steps.length} step(s), source=${e.source})`);
      for (const s of e.plan.steps) {
        console.log(`    · ${s.id}: ${s.intent}`);
        for (const c of s.successCriteria) {
          console.log(`      criterion: ${describeCriterion(c)}`);
        }
      }
    }
    if (e.type === "step_verified") console.log(`  [verify] ${e.stepId} PASS`);
    if (e.type === "fix_started") console.log(`  [fix] ${e.stepId} attempt=${e.attempt} — ${e.reason}`);
    if (e.type === "completed") console.log(`  [done] TASK COMPLETE`);
  });

  const handle = await startTask({
    runtime: fake,
    taskId: TASK_ID,
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus,
    deadlineMs: 120_000,
    policy: undefined,
    workspace: taskDir,
  });
  handle.task.goal = "Create a TypeScript utility function";

  // Simulate runtime writing the TS file when asked to create it.
  const origPrompt = fake.prompt.bind(fake);
  fake.prompt = async (session, message, opts) => {
    const r = await origPrompt(session, message, opts);
    const m = message.match(/([\w-]+\.ts)\b/);
    if (m && m[1] && !message.includes("tsc")) {
      const p = join(taskDir, m[1]);
      await writeFile(p, 'export function util(): string {\n  return "ok";\n}\n', "utf8");
    }
    return r;
  };

  const final = await runOrchestrator(handle);

  console.log("\n--- Final Plan ---");
  if (final.plan) {
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
    final.plan?.steps.some((s) => s.successCriteria.some((c) => c.kind !== "command_exit_zero" && "path" in c && c.path.endsWith(".ts")));
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

function describeCriterion(c: { kind: string; path?: string; pattern?: string; command?: string; name?: string }): string {
  switch (c.kind) {
    case "file_exists":
      return `file_exists(${c.path})`;
    case "file_contains":
      return `file_contains(${c.path}, "${c.pattern}")`;
    case "file_not_contains":
      return `file_not_contains(${c.path}, "${c.pattern}")`;
    case "command_exit_zero":
      return `command_exit_zero(${(c.command ?? "").slice(0, 60)})`;
    case "test_pass":
      return `test_pass(${c.name})`;
    case "git_diff_contains":
      return `git_diff_contains("${c.pattern}")`;
    case "directory_exists":
      return `directory_exists(${c.path})`;
  }
  return c.kind;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
