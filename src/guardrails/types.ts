import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompletionConfig } from "../types.ts";
import type { CostGuard } from "./cost-guard.ts";

/**
 * Minimal approval surface used by guardrail hooks. The concrete hub lives
 * in server/approval-hub.ts; keeping this structural avoids a types → server
 * dependency.
 */
export interface ApprovalRelay {
  /** Resolves when the user approves (true) or denies/expires (false). */
  request(input: {
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<boolean>;
}

export interface GuardrailConfig {
  sessionId: string;
  workspace: string;
  completion: CompletionConfig;
  approval: ApprovalRelay;
  steeringQueue: AgentMessage[];
  costGuard: CostGuard;
}
