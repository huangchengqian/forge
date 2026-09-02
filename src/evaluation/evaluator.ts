import type { TaskSession } from "../core/types/task-session.ts";
import type { Plan } from "../core/types/plan.ts";
import type { Observation } from "../core/types/step.ts";
import type { EvaluationResult } from "../core/types/evaluation.ts";
import type { MemoryItem } from "../memory/index.ts";

export type EvaluationInput = {
  task: TaskSession;
  plan: Plan | null;
  observations: readonly Observation[];
  memory: readonly MemoryItem[];
};

export interface Evaluator {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}
