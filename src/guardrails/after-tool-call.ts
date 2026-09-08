import type {
  AfterToolCallContext,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";
import { appendEvent } from "../core/persistence/event-log.ts";
import { StuckDetector } from "./stuck-detector.ts";
import type { GuardrailConfig } from "./types.ts";

/**
 * After-tool guardrail: stuck detection over the tool-call history. A stuck
 * pattern terminates the session immediately — burning budget on a loop is
 * the worst failure mode (cost guard and maxTurns are the other stoppers).
 */
export function makeAfterToolCall(config: GuardrailConfig) {
  const stuckDetector = new StuckDetector();

  return async (
    ctx: AfterToolCallContext,
    _signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined> => {
    stuckDetector.track({
      toolName: ctx.toolCall.name,
      args: ctx.args ?? (ctx.toolCall as { arguments?: unknown }).arguments,
      result: ctx.result?.details,
      isError: ctx.isError,
    });

    const stuck = stuckDetector.check();
    if (stuck.isStuck) {
      await appendEvent(config.sessionId, "STUCK_WARNING", {
        pattern: stuck.pattern,
        repetitions: stuck.repetitions,
      }).catch(() => {});
      return { terminate: true };
    }

    return undefined;
  };
}
