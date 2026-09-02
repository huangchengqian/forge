import type { TaskSession } from "../src/core/types/task-session.ts";
import type { PersistedEvent } from "../src/core/persistence/event-log.ts";
import type { RuntimeStats, TaskMetrics, BenchmarkSummary } from "./types.ts";

export function computeTaskMetrics(args: {
  benchId: string;
  category: TaskMetrics["category"];
  final: TaskSession;
  events: readonly PersistedEvent[];
  runtimeStats: RuntimeStats;
  wallMs: number;
}): TaskMetrics {
  const { final, events, runtimeStats, wallMs } = args;

  let retries = 0;
  let maxAttempts = 0;
  if (final.plan) {
    for (const s of final.plan.steps) {
      if (s.attempts > 1) retries += s.attempts - 1;
      if (s.attempts > maxAttempts) maxAttempts = s.attempts;
    }
  }
  void maxAttempts;

  const verificationFailures = final.observations.filter((o) => o.result === "FAIL").length;
  const planRevisions = events.filter((e) => e.type === "PLAN_REVISED").length;

  return {
    taskId: final.id,
    benchId: args.benchId,
    category: args.category,
    success: final.state === "COMPLETE",
    finalState: final.state,
    wallMs,
    retries,
    fixCount: final.fixCount,
    planRevisions,
    verificationFailures,
    runtimeFailures: runtimeStats.promptFailures,
    evaluationScore: final.lastEvaluation?.score ?? null,
    evaluationStatus: final.lastEvaluation?.status ?? null,
  };
}

export function summarize(metrics: readonly TaskMetrics[]): BenchmarkSummary {
  const n = metrics.length || 1;
  const successCount = metrics.filter((m) => m.success).length;
  const scores = metrics.map((m) => m.evaluationScore).filter((s): s is number => s !== null);
  return {
    total: metrics.length,
    successCount,
    successRate: Math.round((successCount / n) * 100) / 100,
    totalWallMs: metrics.reduce((a, m) => a + m.wallMs, 0),
    avgWallMs: Math.round(metrics.reduce((a, m) => a + m.wallMs, 0) / n),
    totalRetries: metrics.reduce((a, m) => a + m.retries, 0),
    totalFixCount: metrics.reduce((a, m) => a + m.fixCount, 0),
    totalPlanRevisions: metrics.reduce((a, m) => a + m.planRevisions, 0),
    totalVerificationFailures: metrics.reduce((a, m) => a + m.verificationFailures, 0),
    totalRuntimeFailures: metrics.reduce((a, m) => a + m.runtimeFailures, 0),
    avgEvaluationScore:
      scores.length > 0 ? Math.round((scores.reduce((a, s) => a + s, 0) / scores.length) * 100) / 100 : 0,
  };
}
