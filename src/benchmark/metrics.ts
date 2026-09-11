/**
 * Phase 6 benchmark: metrics extracted from a finished run.
 *
 * Pure extraction from the session's terminal state + the persisted event
 * log — no global state, trivially unit-testable.
 */
import type { PersistedEvent } from "../core/persistence/event-log.ts";
import type { Session } from "../types.ts";

export interface RunMetrics {
  state: "completed" | "failed" | "cancelled";
  failureReason: string | null;
  wallMs: number;
  turns: number;
  tokens: number;
  vfail: number;
  vpass: number;
  verificationSequence: boolean[];
  evalScore: number | null;
  stuckPatterns: string[];
  retries: number;
}

export function extractMetrics(input: {
  session: Session;
  events: readonly PersistedEvent[];
  wallMs: number;
  scriptedErrorTurns: number;
}): RunMetrics {
  const { session, events, wallMs, scriptedErrorTurns } = input;

  const verification = events.filter((e) => e.type === "VERIFICATION_RESULT");
  const verificationSequence = verification.map(
    (e) => (e.payload as { passed?: boolean }).passed === true,
  );

  const stuckPatterns = events
    .filter((e) => e.type === "STUCK_WARNING")
    .map((e) => (e.payload as { pattern?: string }).pattern ?? "unknown");

  const evalScore =
    session.lastEvaluation && typeof session.lastEvaluation.score === "number"
      ? session.lastEvaluation.score
      : null;

  return {
    // Terminal state derived from the session's own records (direct
    // runAgent calls never go through SessionManager.settle): a failure
    // reason means the run was killed (stuck guard / maxTurns / budget /
    // error); anything else that returned normally verified out as done.
    state: session.failureReason !== null ? "failed" : "completed",
    failureReason: session.failureReason,
    wallMs,
    turns: session.messages.length,
    tokens: session.usage.tokensIn + session.usage.tokensOut,
    vfail: verificationSequence.filter((p) => !p).length,
    vpass: verificationSequence.filter((p) => p).length,
    verificationSequence,
    evalScore,
    stuckPatterns,
    retries: scriptedErrorTurns,
  };
}

/** ROADMAP §7 style single-line report. */
export function formatReportLine(name: string, category: string, goal: string, m: RunMetrics): string {
  const evalPart = m.evalScore === null ? "-" : String(m.evalScore);
  return `  -> state=${m.state} wall=${m.wallMs}ms turns=${m.turns} tok=$${m.tokens} vfail=${m.vfail} eval=${evalPart}${m.stuckPatterns.length > 0 ? ` stuck=${m.stuckPatterns.join(",")}` : ""} [${category}] ${goal} (${name})`;
}
