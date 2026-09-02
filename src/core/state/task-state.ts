export type TaskState =
  | "READY"
  | "UNDERSTAND"
  | "PLAN"
  | "EXECUTE"
  | "OBSERVE"
  | "FIX"
  | "EVALUATE"
  | "COMPLETE"
  | "REVIEW_REQUIRED"
  | "FAILED";

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  READY: ["UNDERSTAND", "FAILED"],
  UNDERSTAND: ["PLAN", "FAILED"],
  PLAN: ["EXECUTE", "FAILED"],
  EXECUTE: ["OBSERVE", "FAILED"],
  OBSERVE: ["EXECUTE", "FIX", "EVALUATE", "FAILED"],
  FIX: ["EXECUTE", "FAILED"],
  EVALUATE: ["COMPLETE", "REVIEW_REQUIRED", "FAILED"],
  COMPLETE: [],
  REVIEW_REQUIRED: [],
  FAILED: [],
} as const;

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStates(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from];
}

export function isTerminal(state: TaskState): boolean {
  return state === "COMPLETE" || state === "REVIEW_REQUIRED" || state === "FAILED";
}
