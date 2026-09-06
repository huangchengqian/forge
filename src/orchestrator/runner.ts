import type { Plan } from "../core/types/plan.ts";
import type { PlanStep } from "../core/types/step.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { AgentRuntime, RuntimeSession } from "../runtime/interface.ts";
import type { EventBus } from "../events/index.ts";
import { buildStepPrompt } from "./instruction.ts";
import { publish } from "../events/index.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import { saveTask } from "../core/persistence/task-store.ts";

export type StepRunResult = {
  stepId: string;
  success: boolean;
  error: string | undefined;
};

export async function runStepBatch(
  task: TaskSession,
  steps: readonly PlanStep[],
  session: RuntimeSession,
  runtime: AgentRuntime,
  bus: EventBus | undefined,
  abortSignal?: AbortSignal,
): Promise<{ task: TaskSession; results: readonly StepRunResult[] }> {
  if (steps.length === 0) return { task, results: [] };

  const plan0 = task.plan;
  if (!plan0) return { task, results: [] };

  const updated: PlanStep[] = plan0.steps.map((s) => {
    const picked = steps.find((p) => p.id === s.id);
    if (!picked) return s;
    return { ...s, status: "running", attempts: s.attempts + 1 };
  });

  const runningPlan: Plan = {
    ...plan0,
    steps: updated,
    updatedAt: Date.now(),
  };

  for (const s of steps) {
    publish(bus, { type: "step_started", taskId: task.id, stepId: s.id, at: Date.now() });
    const cur = updated.find((x) => x.id === s.id);
    await appendEvent(task.id, "STEP_STARTED", {
      stepId: s.id,
      intent: s.intent,
      attempt: cur?.attempts ?? 0,
    });
  }

  let partial: TaskSession = {
    ...task,
    plan: runningPlan,
    currentStepId: steps[0]?.id ?? task.currentStepId,
  };
  await saveTask(partial);

  // Steps in a batch share ONE runtime session, and the runtime serializes
  // prompts (a single agent answers in order). Marking every step "running"
  // up front advertised parallelism that did not exist and showed a wrong
  // currentStepId; run them strictly one at a time so the projected state is
  // truthful. Task-level parallelism (separate sessions) is unaffected.
  const results: StepRunResult[] = [];
  for (const s of steps) {
    const prompt = buildStepPrompt(s, partial.goal, partial.directory);
    try {
      const turn = await runtime.prompt(session, prompt, { deadlineMs: 5 * 60_000 });
      results.push({ stepId: s.id, success: turn.success, error: turn.error });
    } catch (err) {
      results.push({ stepId: s.id, success: false, error: err instanceof Error ? err.message : String(err) });
    }
    if (abortSignal?.aborted) return { task: partial, results };
  }

  await saveTask(partial);
  return { task: partial, results };
}
