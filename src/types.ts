import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SuccessCriterion } from "./core/types/criterion.ts";
import type { EvaluationResult } from "./core/types/evaluation.ts";

export type SessionKind = "conversation" | "task";
export type SessionStatus = "running" | "completed" | "failed" | "cancelled";
export type TrustLevel = "low" | "medium" | "high";

/**
 * Reasoning effort, re-exported from Pi so the string set cannot drift.
 * `"off"` means no reasoning parameter is sent at all — see agent-loop.ts,
 * which maps it to `reasoning: undefined` on the outgoing request.
 */
export type { ThinkingLevel };

/**
 * The single data model of the new architecture. The conversation IS the
 * task: messages carry the full history (including tool calls and results),
 * so there is no Plan, no PlanStep, no Observation.
 */
export interface Session {
  id: string;
  kind: SessionKind;
  goal: string;
  workspace: string;
  projectId: string | null;
  model: { provider: string; modelId: string };
  messages: AgentMessage[];
  status: SessionStatus;
  failureReason: string | null;
  /** Cumulative token usage + context watermark (persisted; hydrates UsageTracker on resume). */
  usage: SessionUsage;
  trustLevel: TrustLevel;
  /**
   * Reasoning effort sent with every provider request. Persisted since
   * schema v6 and switchable mid-session (POST /sessions/:id/thinking).
   */
  thinkingLevel: ThinkingLevel;
  completionCriteria: SuccessCriterion[];
  lastEvaluation: EvaluationResult | null;
  /** Turn budget; null = unbounded. Persisted since schema v5 (survives resume). */
  maxTurns: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Cumulative token usage for a session (fed from assistant-message usage). */
export interface SessionUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Latest assistant turn's context size — the compaction watermark. */
  lastContextTokens: number | null;
}

export interface CompletionConfig {
  trustLevel: TrustLevel;
  criteria: SuccessCriterion[];
  maxTurns: number | null;
}
