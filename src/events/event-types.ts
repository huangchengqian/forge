import type { Session } from "../types.ts";
import type { EvaluationResult } from "../core/types/evaluation.ts";

/**
 * Forge events are the in-process control-plane stream (EventBus → SSE).
 * They are distinct from the persisted agent events in the JSONL log:
 * lifecycle + guardrail notifications, not the raw agent transcript.
 */
export type ForgeEvent =
  | { type: "session_started"; sessionId: string; goal: string; at: number }
  | {
      type: "session_ended";
      sessionId: string;
      status: Session["status"];
      at: number;
    }
  | { type: "steering_queued"; sessionId: string; at: number }
  | { type: "guard_blocked"; sessionId: string; toolName: string; reason: string; at: number }
  | {
      type: "guard_approval_request";
      sessionId: string;
      requestId: string;
      toolName: string;
      at: number;
    }
  | { type: "verification_result"; sessionId: string; passed: boolean; reason?: string; at: number }
  | { type: "cost_update"; sessionId: string; spent: number; budget: number | null; at: number }
  | { type: "stuck_warning"; sessionId: string; pattern: string; repetitions: number; at: number }
  | { type: "evaluation_completed"; sessionId: string; result: EvaluationResult; at: number };

export type EventListener = (event: ForgeEvent) => void;
