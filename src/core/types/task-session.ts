import type { TaskState } from "../state/task-state.ts";
import type { Plan } from "./plan.ts";
import type { Observation } from "./step.ts";
import type { EvaluationResult } from "./evaluation.ts";

export type RuntimeSessionInfo = {
  id: string;
  directory: string;
  createdAt: number;
  modelProvider: string;
  modelId: string;
};

export type TaskSession = {
  id: string;
  goal: string;
  state: TaskState;
  /**
   * Session flavor (Phase 9.7). Absent/undefined = "task" (legacy and
   * default). "conversation" sessions never run a Task lifecycle — they are
   * plain chat records answered by the server-side Intent Router.
   */
  kind?: "conversation" | "task";
  plan: Plan | null;
  currentStepId: string | null;
  observations: readonly Observation[];
  runtime: RuntimeSessionInfo | null;
  piSessionId: string | null;
  /** Runtime session directory (equals workspacePath today; kept for runtime info). */
  directory: string;
  /** Exact execution workspace (project.path for in-place tasks). Schema v3. */
  workspacePath: string | null;
  /** projects.json record id when the task is bound to a project; else null. Schema v3. */
  projectId: string | null;
  model: {
    provider: string;
    modelId: string;
  };
  fixCount: number;
  createdAt: number;
  updatedAt: number;
  failureReason: string | null;
  lastEvaluation: EvaluationResult | null;
};
