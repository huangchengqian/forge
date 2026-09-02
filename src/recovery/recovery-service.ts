import { isTerminal } from "../core/state/task-state.ts";
import { loadTask } from "../core/persistence/task-store.ts";
import { readEvents } from "../core/persistence/event-log.ts";
import { computeReadySteps } from "../orchestrator/scheduler.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { PersistedEvent } from "../core/persistence/event-log.ts";

export type RecoveryDecision =
  | { kind: "recoverable"; task: TaskSession; reason: string }
  | { kind: "not_found"; taskId: string }
  | { kind: "already_completed"; task: TaskSession }
  | { kind: "failed"; task: TaskSession; reason: string }
  | { kind: "invalid"; taskId: string; reason: string };

export type RecoveryPlan = {
  task: TaskSession;
  events: readonly PersistedEvent[];
  resumeFrom: string;
  runtimeSessionLost: boolean;
  readyStepIdsOnResume: readonly string[];
};

export class TaskRecoveryService {
  async inspect(taskId: string): Promise<RecoveryDecision> {
    const task = await loadTask(taskId);
    if (!task) return { kind: "not_found", taskId };

    if (isTerminal(task.state)) {
      if (task.state === "COMPLETE") {
        return { kind: "already_completed", task };
      }
      const reason =
        task.state === "REVIEW_REQUIRED"
          ? task.failureReason ?? "evaluation requires review"
          : task.failureReason ?? "task failed";
      return { kind: "failed", task, reason };
    }

    return { kind: "recoverable", task, reason: `task in state ${task.state}` };
  }

  async plan(taskId: string): Promise<RecoveryPlan | null> {
    const decision = await this.inspect(taskId);
    if (decision.kind !== "recoverable") return null;

    const task = decision.task;
    const events = await readEvents(taskId);

    const resumeFrom = task.currentStepId
      ?? task.plan?.steps.find((s) => s.status === "running" || s.status === "pending" || s.status === "failed")?.id
      ?? null;

    const runtimeSessionLost = task.runtime === null || task.piSessionId === null;

    let readyStepIdsOnResume: readonly string[] = [];
    if (task.plan) {
      const completedIds = new Set(
        task.plan.steps.filter((s) => s.status === "verified").map((s) => s.id),
      );
      readyStepIdsOnResume = computeReadySteps(task.plan, completedIds).map((s) => s.id);
    }

    return {
      task,
      events,
      resumeFrom: resumeFrom ?? "start",
      runtimeSessionLost,
      readyStepIdsOnResume,
    };
  }
}
