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
  | "FAILED"
  | "CANCELLED";

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  READY: ["UNDERSTAND", "FAILED", "CANCELLED"],
  UNDERSTAND: ["PLAN", "FAILED", "CANCELLED"],
  PLAN: ["EXECUTE", "FAILED", "CANCELLED"],
  EXECUTE: ["OBSERVE", "FAILED", "CANCELLED"],
  OBSERVE: ["EXECUTE", "FIX", "EVALUATE", "FAILED", "CANCELLED"],
  FIX: ["EXECUTE", "FAILED", "CANCELLED"],
  EVALUATE: ["COMPLETE", "REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  COMPLETE: [],
  REVIEW_REQUIRED: [],
  FAILED: [],
  CANCELLED: [],
} as const;

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStates(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from];
}

export function isTerminal(state: TaskState): boolean {
  return state === "COMPLETE" || state === "REVIEW_REQUIRED" || state === "FAILED" || state === "CANCELLED";
}
