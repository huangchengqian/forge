import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SuccessCriterion } from "./core/types/criterion.ts";
import type { EvaluationResult } from "./core/types/evaluation.ts";

export type SessionKind = "conversation" | "task";
export type SessionStatus = "running" | "completed" | "failed" | "cancelled";
export type TrustLevel = "low" | "medium" | "high";

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
  model: { provider: string; modelId: string; effort?: string };
  messages: AgentMessage[];
  status: SessionStatus;
  failureReason: string | null;
  cost: { total: number; budget: number | null };
  trustLevel: TrustLevel;
  completionCriteria: SuccessCriterion[];
  lastEvaluation: EvaluationResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompletionConfig {
  trustLevel: TrustLevel;
  criteria: SuccessCriterion[];
  maxCost: number | null;
  maxTurns: number | null;
}
