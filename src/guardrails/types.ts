import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompletionConfig, Session } from "../types.ts";
import type { UsageTracker } from "./usage-tracker.ts";

/**
 * Minimal approval surface used by guardrail hooks. The concrete hub lives
 * in server/approval-hub.ts; keeping this structural avoids a types → server
 * dependency.
 */
export interface ApprovalRelay {
  /** Resolves when the user approves (true) or denies/expires/aborts (false). */
  request(
    input: {
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface GuardrailConfig {
  sessionId: string;
  workspace: string;
  /**
   * Per-session undo journal root (`<forgeHome>/undo/<sessionId>`). Explicit,
   * not read from a process env var — the in-process loop hosts many sessions
   * in one process, so a global cannot carry a per-session value.
   */
  undoRoot: string;
  /** Live session reference: the stop gate writes failureReason/lastEvaluation. */
  session: Session;
  completion: CompletionConfig;
  approval: ApprovalRelay;
  steeringQueue: AgentMessage[];
  usage: UsageTracker;
}
