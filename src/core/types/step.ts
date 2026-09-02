import type { SuccessCriterion, CriterionResult } from "./criterion.ts";

export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "verified"
  | "failed"
  | "cancelled";

export type PlanStep = {
  id: string;
  intent: string;
  status: StepStatus;
  attempts: number;
  successCriteria: readonly SuccessCriterion[];
  dependencies: readonly string[];
  executionGroup: string | undefined;
};

export type Observation = {
  id: string;
  stepId: string;
  result: "PASS" | "FAIL";
  attempt: number;
  criterionResults: readonly CriterionResult[];
  failureReason: string | undefined;
  timestamp: number;
};
