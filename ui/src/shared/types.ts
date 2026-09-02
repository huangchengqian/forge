// Local mirror of Forge event/memory/criterion/task types.
// Source of truth lives in /Users/hcq/forge/src/.
// Keep this file in sync manually until Phase 5 introduces a shared types package.

export type TaskState =
  | "READY"
  | "UNDERSTAND"
  | "PLAN"
  | "EXECUTE"
  | "OBSERVE"
  | "FIX"
  | "COMPLETE"
  | "FAILED";

export type SuccessCriterion =
  | { kind: "command_exit_zero"; command: string; cwd?: string }
  | { kind: "file_exists"; path: string }
  | { kind: "file_contains"; path: string; pattern: string }
  | { kind: "test_pass"; name: string };

export type CriterionResult = {
  criterion: SuccessCriterion;
  passed: boolean;
  message: string;
  exitCode?: number;
  output?: string;
};

export type StepStatus = "pending" | "running" | "verified" | "failed";

export type PlanStep = {
  id: string;
  intent: string;
  status: StepStatus;
  attempts: number;
  successCriteria: readonly SuccessCriterion[];
};

export type Observation = {
  id: string;
  stepId: string;
  result: "PASS" | "FAIL";
  attempt: number;
  criterionResults: readonly CriterionResult[];
  failureReason?: string;
  timestamp: number;
};

export type Plan = {
  id: string;
  version: number;
  objective: string;
  steps: readonly PlanStep[];
  createdAt: number;
};

export type TaskSession = {
  id: string;
  goal: string;
  state: TaskState;
  plan: Plan | null;
  observations: readonly Observation[];
  piSessionId: string | null;
  directory: string;
  model: { provider: string; modelId: string };
  fixCount: number;
  createdAt: number;
  updatedAt: number;
  failureReason: string | null;
};

export type MemoryType = "PROJECT_FACT" | "DECISION" | "FAILURE_PATTERN" | "SOLUTION";
export type MemorySource = "VERIFICATION" | "OBSERVATION" | "USER" | "REPO";

export type MemoryItem = {
  id: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  confidence: number;
  keywords: readonly string[];
  createdAt: number;
  updatedAt: number;
  taskRefs: readonly string[];
};

export type RetrievedMemory = {
  item: MemoryItem;
  score: number;
  matchedKeywords: readonly string[];
};

export type ForgeEvent =
  | { type: "task_started"; taskId: string; goal: string; at: number }
  | {
      type: "state_changed";
      taskId: string;
      from: TaskState;
      to: TaskState;
      at: number;
    }
  | { type: "step_started"; taskId: string; stepId: string; at: number }
  | { type: "step_verified"; taskId: string; stepId: string; at: number }
  | {
      type: "fix_started";
      taskId: string;
      stepId: string;
      attempt: number;
      reason: string;
      at: number;
    }
  | {
      type: "memory_retrieved";
      taskId: string;
      query: string;
      results: readonly RetrievedMemory[];
      at: number;
    }
  | {
      type: "memory_extracted";
      taskId: string;
      items: readonly MemoryItem[];
      at: number;
    }
  | { type: "completed"; taskId: string; at: number }
  | { type: "failed"; taskId: string; reason: string; at: number }
  | {
      type: "pi_event";
      taskId: string;
      sessionId: string;
      payload: unknown;
      at: number;
    };
