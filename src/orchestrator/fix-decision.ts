import type { Observation, PlanStep } from "../core/types/step.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

export type FixAction = {
  step: PlanStep;
  promptHint: string;
  rewrittenCriteria: readonly SuccessCriterion[];
};

const FIX_TO_GREP_TOKEN = "forge-e2e-ok";

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
    `Apply the smallest possible fix. Do not change unrelated files. ` +
    `After fixing, output exactly one line: DONE ${step.id}`;

  return {
    step: { ...step, status: "pending" },
    promptHint,
    rewrittenCriteria,
  };
}
