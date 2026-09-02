import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startTask, runOrchestrator } from "../orchestrator/index.ts";
import { EventBus } from "../events/index.ts";
import { FakeRuntime } from "./fake-runtime.ts";
import { SkillRegistry } from "../skills/index.ts";

const TMP = "/tmp/forge-seam-test";

export async function runSeamTest(): Promise<boolean> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "tasks"), { recursive: true });
  process.env.FORGE_TASKS_DIR = join(TMP, "tasks");
  process.env.FORGE_MEMORY_PATH = join(TMP, "memory.json");

  const taskDir = join(TMP, "tasks", "seam-task");
  const fake = new FakeRuntime(TMP, {
    steps: [
      {
        intent: "create hello.txt",
        criteria: [
          { kind: "file_exists", path: "hello.txt" },
          { kind: "file_contains", path: "hello.txt", pattern: "hello" },
        ],
      },
    ],
  });

  const bus = new EventBus();
  const states: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "state_changed") states.push(`${e.from}->${e.to}`);
  });

  console.log("=== Runtime Seam Verification (FakeRuntime, no Pi) ===");
  console.log(`runtime class: ${fake.constructor.name}`);

  const handle = await startTask({
    runtime: fake,
    taskId: "seam-task",
    provider: "fake",
    modelId: "fake",
    env: undefined,
    eventBus: bus,
    deadlineMs: 30_000,
    policy: undefined,
    skillRegistry: new SkillRegistry(),
    workspace: taskDir,
  });
  handle.task.goal = "create hello.txt";

  await writeFile(join(taskDir, "hello.txt"), "hello\n", "utf8");

  const final = await runOrchestrator(handle);

  console.log("state transitions:");
  for (const s of states) console.log(`  ${s}`);
  console.log(`final state: ${final.state}`);
  console.log(`observations: ${final.observations.length}`);
  for (const o of final.observations) {
    console.log(`  [${o.result}] ${o.stepId} attempt=${o.attempt}`);
  }
  console.log(`runtime prompt calls: ${fake.promptCalls.length}`);
  console.log(`runtime destroy calls: ${fake.destroyCalls}`);

  const pass =
    final.state === "COMPLETE" &&
    fake.promptCalls.length >= 2 &&
    fake.destroyCalls === 0 &&
    (await runRedLineChecks(TMP));
  console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

/**
 * Red-line assertions (docs/16 §5.3):
 * 1. The adapter honors the requested workspace EXACTLY (no derived subdirectory).
 * 2. destroy() never deletes the workspace — in in-place mode it is the user's
 *    real project directory.
 */
async function runRedLineChecks(tmpRoot: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const { readFile } = await import("node:fs/promises");

  console.log("\n=== Red-line: exact workspace + destroy never deletes ===");
  const projectDir = join(tmpRoot, "redline-project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "keep.txt"), "user data\n", "utf8");

  const fake = new FakeRuntime(tmpRoot, { steps: [] });
  const session = await fake.createSession({
    taskId: "redline-task",
    goal: "redline check",
    workspace: projectDir,
    model: { provider: "fake", modelId: "fake" },
    env: undefined,
  });
  const exactDir = resolve(session.directory) === resolve(projectDir);

  await fake.destroy(session);
  let survived = false;
  try {
    const content = await readFile(join(projectDir, "keep.txt"), "utf8");
    survived = (await stat(projectDir)).isDirectory() && content === "user data\n";
  } catch {}

  console.log(`  session.directory === requested workspace: ${exactDir}`);
  console.log(`  workspace survives destroy(): ${survived}`);
  return exactDir && survived;
}

if (process.argv[1]?.endsWith("seam-test.ts")) {
  runSeamTest().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
