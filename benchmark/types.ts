import type { Planner } from "../src/orchestrator/planner.ts";
import type { TaskSession } from "../src/core/types/task-session.ts";

export type GoldenCategory = "new-feature" | "bug-fix" | "refactor" | "test-addition" | "config-change";

export type GoldenTask = {
  id: string;
  category: GoldenCategory;
  title: string;
  goal: string;
  buildPlanner: (workspace: string) => Planner;
  perform: (stepId: string, workspace: string, attempt: number) => Promise<void>;
};

export type RuntimeStats = {
  prompts: number;
  promptFailures: number;
};

export type TaskMetrics = {
  taskId: string;
  benchId: string;
  category: GoldenCategory;
  success: boolean;
  finalState: TaskSession["state"];
  wallMs: number;
  retries: number;
  fixCount: number;
  planRevisions: number;
  verificationFailures: number;
  runtimeFailures: number;
  evaluationScore: number | null;
  evaluationStatus: string | null;
};

export type BenchmarkSummary = {
  total: number;
  successCount: number;
  successRate: number;
  totalWallMs: number;
  avgWallMs: number;
  totalRetries: number;
  totalFixCount: number;
  totalPlanRevisions: number;
  totalVerificationFailures: number;
  totalRuntimeFailures: number;
  avgEvaluationScore: number;
};
