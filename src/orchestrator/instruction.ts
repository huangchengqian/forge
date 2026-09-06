import type { PlanStep } from "../core/types/step.ts";

/**
 * The verification command policy, phrased for the model. Verification
 * criteria run through Forge's command allowlist; a model that does not know
 * the list proposes blind commands (cat-style reads, arbitrary scripts),
 * fails verification repeatedly, and burns the FIX budget on a correct
 * artifact. Telling it up front removes that whole failure class.
 */
export const VERIFICATION_GUIDANCE = [
  "Verification rules:",
  "- Verification commands are restricted. Allowed: project runners (npm/pnpm/yarn/bun test|run test|lint|typecheck|build), `npx tsc --noEmit`, `node --test`, and read-only commands (cat, ls, head, tail, wc, stat, file, grep, diff, du, test), including pipes between them.",
  "- Anything else (custom scripts, redirects, writing via the command) will be REJECTED by the Guard even if the artifact is correct.",
].join("\n");

export function buildStepPrompt(step: PlanStep, goal: string, cwd: string): string {
  return [
    "You are Forge's engineering agent, completing one step of a coding task.",
    "",
    `Task goal: ${goal}`,
    `Working directory: ${cwd}`,
    "",
    `Current step: ${step.id}`,
    `Step intent: ${step.intent}`,
    "",
    "How to complete this step:",
    "- The \"intent\" describes WHAT to accomplish. It is NOT a shell command to run verbatim.",
    "- Use the right tool: `write`/`edit` to create or modify files, `read`/`grep` to inspect, `bash` only to run commands, tests, or builds.",
    "- Do not echo the intent into a shell. Do not work on any other step.",
    VERIFICATION_GUIDANCE,
    "- After finishing, reply with a single line: DONE " + step.id,
  ].join("\n");
}
