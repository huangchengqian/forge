import type { Session } from "../types.ts";
import type { EvaluationResult } from "../core/types/evaluation.ts";

export type EvaluationInput = {
  session: Session;
};

export interface Evaluator {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}
