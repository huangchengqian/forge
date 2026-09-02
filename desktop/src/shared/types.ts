export type TaskState =
  | "READY" | "UNDERSTAND" | "PLAN" | "EXECUTE" | "OBSERVE"
  | "FIX" | "EVALUATE" | "COMPLETE" | "REVIEW_REQUIRED" | "FAILED";

export type StepStatus = "pending" | "ready" | "running" | "verified" | "failed" | "cancelled";

export type PlanStep = {
  id: string;
  intent: string;
  status: StepStatus;
  attempts: number;
  dependencies: readonly string[];
};

export type Observation = {
  id: string;
  stepId: string;
  result: "PASS" | "FAIL";
  attempt: number;
  failureReason?: string;
  timestamp: number;
};

export type Plan = { id: string; version: number; objective: string; steps: readonly PlanStep[]; createdAt: number; updatedAt: number };

export type TaskSession = {
  id: string;
  goal: string;
  state: TaskState;
  kind?: "conversation" | "task";
  plan: Plan | null;
  currentStepId: string | null;
  observations: readonly Observation[];
  fixCount: number;
  createdAt: number;
  updatedAt: number;
  failureReason: string | null;
  projectId: string | null;
  lastEvaluation: { score: number; status: string; findings: { rule: string; severity: string; message: string }[] } | null;
};

export type MemoryType = "PROJECT_FACT" | "DECISION" | "FAILURE_PATTERN" | "SOLUTION";
export type MemoryItem = {
  id: string; type: MemoryType; content: string; source: string;
  confidence: number; keywords: readonly string[];
  createdAt: number; updatedAt: number; taskRefs: readonly string[];
};
