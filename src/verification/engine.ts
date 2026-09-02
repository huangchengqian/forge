import type { CriterionResult, SuccessCriterion } from "../core/types/criterion.ts";
import { validate } from "./validate.ts";

export type VerificationResult = {
  stepId: string;
  passed: boolean;
  failed: readonly CriterionResult[];
  reasons: readonly string[];
  criteriaResults: readonly CriterionResult[];
  metadata: Record<string, unknown>;
};

export async function verifyCriteria(
  stepId: string,
  criteria: readonly SuccessCriterion[],
  baseCwd: string,
): Promise<VerificationResult> {
  const results: CriterionResult[] = [];
  for (const c of criteria) {
    results.push(await validate(c, baseCwd));
  }

  const failed = results.filter((r) => !r.passed);
  const passed = failed.length === 0;
  const reasons = failed.map((r) => `${r.criterion.kind}: ${r.message}`);

  return {
    stepId,
    passed,
    failed,
    reasons,
    criteriaResults: results,
    metadata: {
      total: results.length,
      failedCount: failed.length,
      passedCount: results.length - failed.length,
      criteriaKinds: results.map((r) => r.criterion.kind),
    },
  };
}
