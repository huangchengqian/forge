import type { Observation, PlanStep } from "../core/types/step.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";
import { VERIFICATION_GUIDANCE } from "./instruction.ts";

export type FixAction = {
  step: PlanStep;
  promptHint: string;
  rewrittenCriteria: readonly SuccessCriterion[];
};

const FIX_TO_GREP_TOKEN = "forge-e2e-ok";

/** Describe a criterion in one human-readable line for FIX prompts. */
function describeCriterion(c: SuccessCriterion): string {
  switch (c.kind) {
    case "file_exists":
    case "directory_exists":
      return `${c.kind}: ${c.path}`;
    case "file_contains":
      return `file_contains: ${c.path} must contain "${c.pattern}"`;
    case "file_not_contains":
      return `file_not_contains: ${c.path} must NOT contain "${c.pattern}"`;
    case "command_exit_zero":
      return `command_exit_zero: ${c.command}`;
    case "test_pass":
      return `test_pass: ${c.name}`;
    case "git_diff_contains":
      return `git_diff_contains: "${c.pattern}"`;
  }
}

/**
 * Stable signature of WHY an observation failed (sorted failed-criterion
 * kinds + messages). Two consecutive observations of a step with the same
 * signature mean the FIX loop is not learning — retrying again just burns
 * budget.
 */
export function failureSignature(obs: Observation): string {
  const failed = obs.criterionResults.filter((c) => !c.passed);
  if (failed.length > 0) {
    return failed.map((c) => `${c.criterion.kind}:${c.message}`).sort().join("|");
  }
  return obs.failureReason ?? "unknown";
}

export function decideFix(
  step: PlanStep,
  lastObservation: Observation,
  workingDirectory: string,
): FixAction {
  const failedCriteria = lastObservation.criterionResults.filter((c) => !c.passed);
  const summary = failedCriteria
    .map((c) => {
      const tail = c.output && c.output.length > 0 ? `\n      output: ${c.output.slice(-200).replace(/\n/g, " ")}` : "";
      return `  - ${c.criterion.kind}: ${c.message}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ""}${tail}`;
    })
    .join("\n");

  const rewrittenCriteria = step.successCriteria.map((c): SuccessCriterion => {
    if (c.kind !== "command_exit_zero") return c;
    if (!failedCriteria.some((fc) => fc.criterion === c)) return c;
    if (!/wrong-content/.test(c.command)) return c;
    return {
      ...c,
      command: `bash -c 'test -f "${workingDirectory}/hello.txt" && grep -q "${FIX_TO_GREP_TOKEN}" "${workingDirectory}/hello.txt"'`,
    };
  });

  const promptHint =
    `Previous attempt failed on step ${step.id} (attempt ${lastObservation.attempt}).\n` +
    `Goal: keep the same intent: "${step.intent}"\n` +
    `Working directory: ${workingDirectory}\n` +
    `Previous failures:\n${summary}\n` +
    `Success criteria to satisfy:\n${step.successCriteria.map((c) => `  - ${describeCriterion(c)}`).join("\n")}\n` +
    `${VERIFICATION_GUIDANCE}\n` +
    `Apply the smallest possible fix. Do not change unrelated files. ` +
    `After fixing, output exactly one line: DONE ${step.id}`;

  return {
    step: { ...step, status: "pending" },
    promptHint,
    rewrittenCriteria,
  };
}
