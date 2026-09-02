import type { Plan } from "../core/types/plan.ts";
import type { PlanStep } from "../core/types/step.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

export type PlanOperation =
  | { op: "add"; step: PlanStep }
  | { op: "remove"; stepId: string }
  | { op: "update"; step: PlanStep }
  | { op: "reorder"; stepIds: readonly string[] };

export type PlanMutationResult = {
  plan: Plan;
  ops: readonly PlanOperation[];
};

export function applyPlanOps(
  plan: Plan,
  ops: readonly PlanOperation[],
): PlanMutationResult {
  let steps = [...plan.steps];
  for (const op of ops) {
    switch (op.op) {
      case "add":
        if (!steps.some((s) => s.id === op.step.id)) {
          steps.push(op.step);
        }
        break;
      case "remove":
        steps = steps.filter((s) => s.id !== op.stepId);
        break;
      case "update":
        steps = steps.map((s) => (s.id === op.step.id ? op.step : s));
        break;
      case "reorder": {
        const byId = new Map(steps.map((s) => [s.id, s] as const));
        steps = op.stepIds
          .map((id) => byId.get(id))
          .filter((s): s is PlanStep => s !== undefined);
        break;
      }
    }
  }
  const next: Plan = {
    ...plan,
    steps,
    version: plan.version + 1,
    updatedAt: Date.now(),
  };
  return { plan: next, ops };
}

export function newStep(
  id: string,
  intent: string,
  successCriteria: readonly SuccessCriterion[],
  deps: readonly string[] = [],
): PlanStep {
  return { id, intent, status: "pending", attempts: 0, successCriteria, dependencies: deps, executionGroup: undefined };
}
