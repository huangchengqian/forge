import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentRuntime, CreateSessionOptions, PromptOptions, RuntimeSession, TurnResult } from "../src/runtime/interface.ts";
import { SkillRegistry } from "../src/skills/index.ts";
import { readEvents } from "../src/core/persistence/event-log.ts";
import { runOrchestrator, startTask } from "../src/orchestrator/index.ts";
import { computeTaskMetrics } from "./metrics.ts";
import { ScriptedRuntime } from "./scripted-runtime.ts";
import { seedFixture } from "./golden.ts";
import { benchRoot } from "./env-first.ts";
import type { GoldenTask, RuntimeStats, TaskMetrics } from "./types.ts";

class InstrumentedRuntime implements AgentRuntime {
  readonly stats: RuntimeStats = { prompts: 0, promptFailures: 0 };

  constructor(private readonly inner: AgentRuntime) {}

  async createSession(opts: CreateSessionOptions): Promise<RuntimeSession> {
    return this.inner.createSession(opts);
  }

  async prompt(session: RuntimeSession, message: string, opts?: PromptOptions): Promise<TurnResult> {
    this.stats.prompts++;
    try {
      const r = await this.inner.prompt(session, message, opts);
      if (!r.success) this.stats.promptFailures++;
      return r;
    } catch (err) {
      this.stats.promptFailures++;
      throw err;
    }
  }

  async abort(session: RuntimeSession): Promise<void> {
    return this.inner.abort(session);
  }

  async destroy(session: RuntimeSession): Promise<void> {
    return this.inner.destroy(session);
  }
}

export type HarnessPaths = {
  tasksDir: string;
  eventsDir: string;
  memoryPath: string;
};

export function makeHarnessPaths(base: string): HarnessPaths {
  return {
    tasksDir: join(base, "tasks"),
    eventsDir: join(base, "events"),
    memoryPath: join(base, "memory.json"),
  };
}

export async function runGoldenTask(args: {
  task: GoldenTask;
  keepWorkspace: boolean;
}): Promise<TaskMetrics> {
  const { task } = args;

  const benchId = `bench_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const inner = new ScriptedRuntime(task.perform);
  const runtime = new InstrumentedRuntime(inner);

  console.log(`\n=== ${task.id} [${task.category}] ${task.title}`);
  const t0 = Date.now();

  const handle = await startTask({
    runtime,
    taskId: benchId,
    provider: "bench",
    modelId: "deterministic",
    env: {},
    eventBus: undefined,
    deadlineMs: 120_000,
    policy: undefined,
    skillRegistry: new SkillRegistry(),
    workspace: join(benchRoot(), "workspaces", benchId),
    planner: task.buildPlanner(""),
  });
  handle.task.goal = task.goal;

  await seedFixture(handle.task.directory);

  const final = await runOrchestrator(handle);
  const wallMs = Date.now() - t0;

  const events = await readEvents(benchId);
  const metrics = computeTaskMetrics({
    benchId: task.id,
    category: task.category,
    final,
    events,
    runtimeStats: runtime.stats,
    wallMs,
  });

  console.log(
    `  -> state=${metrics.finalState} wall=${wallMs}ms retries=${metrics.retries} ` +
      `fix=${metrics.fixCount} vfail=${metrics.verificationFailures} ` +
      `eval=${metrics.evaluationScore ?? "-"} runtimeFails=${metrics.runtimeFailures}`,
  );

  if (!args.keepWorkspace) {
    await rm(final.directory, { recursive: true, force: true }).catch(() => {});
  }
  return metrics;
}
