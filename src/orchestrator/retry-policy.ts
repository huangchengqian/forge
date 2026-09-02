export type RetryPolicy = {
  maxAttemptsPerStep: number;
  maxFixesPerTask: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttemptsPerStep: 3,
  maxFixesPerTask: 10,
};

export type RetryCheck =
  | { kind: "ok" }
  | { kind: "step_attempts_exhausted"; stepId: string; attempts: number }
  | { kind: "task_fix_budget_exhausted"; fixCount: number };

export function checkStepAttempts(
  step: { id: string; attempts: number },
  policy: RetryPolicy,
): RetryCheck {
  if (step.attempts >= policy.maxAttemptsPerStep) {
    return { kind: "step_attempts_exhausted", stepId: step.id, attempts: step.attempts };
  }
  return { kind: "ok" };
}

export function checkFixBudget(taskFixCount: number, policy: RetryPolicy): RetryCheck {
  if (taskFixCount >= policy.maxFixesPerTask) {
    return { kind: "task_fix_budget_exhausted", fixCount: taskFixCount };
  }
  return { kind: "ok" };
}
