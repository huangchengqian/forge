/**
 * Control-plane events: lifecycle + guardrail notifications.
 *
 * Architecture (see docs/25): these are the subset of `PersistedEventType`
 * that should fan out from the JSONL event log into the in-process
 * `EventBus`. Data-plane events (the TURN/MESSAGE/TEXT_DELTA/TOOL families)
 * stay in the log only — they are high-frequency and not actionable as
 * notifications.
 *
 * The bus is the fan-out target for in-process subscribers (analytics,
 * watchdog, cross-guardrail coordination). SSE and the desktop UI read the
 * event log directly and do NOT consume the bus.
 */

export type ControlEventType =
  // lifecycle
  | "SESSION_CREATED"
  | "SESSION_STARTED"
  | "SESSION_RESUMED"
  | "SESSION_ENDED"
  | "SESSION_FAILED"
  | "SESSION_CANCELLED"
  // guardrails
  | "STEERING_QUEUED"
  | "VERIFICATION_RESULT"
  | "COST_UPDATE"
  | "STUCK_WARNING"
  | "GUARD_BLOCKED"
  | "GUARD_APPROVAL_REQUEST"
  | "EVALUATION_COMPLETED"
  // compaction
  | "COMPACTION"
  | "COMPACTION_FAILED";

export type ControlEvent = {
  id: string;
  type: ControlEventType;
  taskId: string;
  at: number;
  payload: Record<string, unknown>;
};

export type ControlEventListener = (event: ControlEvent) => void;