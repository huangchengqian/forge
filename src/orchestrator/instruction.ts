import type { PlanStep } from "../core/types/step.ts";

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
    "- After finishing, reply with a single line: DONE " + step.id,
  ].join("\n");
}
