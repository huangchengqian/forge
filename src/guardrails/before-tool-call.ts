import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { evaluateToolCall, loadPolicy } from "../guard/policy.ts";
import { journalFile } from "../guard/journal.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import type { GuardrailConfig } from "./types.ts";

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Guard pipeline for every tool call, injected as Pi's beforeToolCall hook:
 * 1. capability policy (allow / ask / deny — same rules as the agent's bash)
 * 2. undo journal backup before any file mutation
 * 3. destructive deny terminates the session
 * 4. `ask` relays to the desktop approval dialog and blocks until decided
 */
export function makeBeforeToolCall(config: GuardrailConfig) {
  return async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = ctx.toolCall.name;
    const input = (ctx.args ?? (ctx.toolCall as { arguments?: unknown }).arguments ?? {}) as Record<
      string,
      unknown
    >;

    // 1. Capability policy.
    const decision = evaluateToolCall(loadPolicy(), toolName, input);

    if (decision.action === "deny") {
      await appendEvent(config.sessionId, "STUCK_WARNING", {
        kind: "guard_denied",
        toolName,
        reason: decision.reason ?? "denied by policy",
      }).catch(() => {});
      return {
        block: true,
        reason: decision.reason ?? "denied by Forge guard policy",
        terminate: decision.terminate === true,
      };
    }

    // 2. Undo journal backup before file mutation.
    if (
      (toolName === "write" || toolName === "edit") &&
      typeof input.path === "string" &&
      input.path.length > 0
    ) {
      await journalFile(config.workspace, input.path).catch(() => {});
    }

    // 3. `ask` → approval dialog, blocking with a hard timeout.
    if (decision.action === "ask") {
      const requestId = ctx.toolCall.id;
      await appendEvent(config.sessionId, "STEERING_QUEUED", {
        kind: "guard_approval_request",
        requestId,
        toolName,
      }).catch(() => {});
      const approved = await config.approval.request({
        requestId,
        toolName,
        input,
        timeoutMs: APPROVAL_TIMEOUT_MS,
      });
      if (signal?.aborted) {
        return { block: true, reason: "aborted", terminate: true };
      }
      if (!approved) {
        return { block: true, reason: "rejected by user" };
      }
    }

    return undefined; // allow
  };
}
