type TaskState = string;

export const STATE_LABELS: Readonly<Record<TaskState, string>> = {
  READY: "Preparing",
  UNDERSTAND: "Analyzing project",
  PLAN: "Creating plan",
  EXECUTE: "Executing steps",
  OBSERVE: "Verifying results",
  FIX: "Fixing issues",
  EVALUATE: "Evaluating quality",
  COMPLETE: "Completed",
  REVIEW_REQUIRED: "Needs your review",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function stateLabel(state: TaskState): string {
  return STATE_LABELS[state] ?? state;
}

export function stateDescription(state: TaskState): string {
  switch (state) {
    case "READY": return "Task created, about to start";
    case "UNDERSTAND": return "Reading the workspace and planning an approach";
    case "PLAN": return "Plan created, preparing execution";
    case "EXECUTE": return "Running tools and writing code";
    case "OBSERVE": return "Checking results against success criteria";
    case "FIX": return "Something failed, attempting automatic repair";
    case "EVALUATE": return "Scoring overall quality of the work";
    case "COMPLETE": return "All steps verified and quality checked";
    case "REVIEW_REQUIRED": return "Quality check flagged issues that need human review";
    case "FAILED": return "Task could not be completed";
    case "CANCELLED": return "Stopped by you before completion";
    default: return state;
  }
}
