import type {
  AgentContext,
  AgentLoopTurnUpdate,
  PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type { CostGuard } from "./cost-guard.ts";

/**
 * Default thresholds. 120K input tokens is 60% of a 200K context window —
 * leaves room for Pi's own summarization pass to assemble the summary plus
 * the kept recent messages without overshooting the model's window.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 120_000;
export const DEFAULT_KEEP_RECENT_MESSAGES = 20;

/**
 * Build the `prepareNextTurn` hook.
 *
 * Contract (per Pi's `AgentLoopConfig.prepareNextTurn`):
 *   - Must not throw. Return undefined when no compaction is warranted.
 *   - When compaction is warranted, return an `AgentLoopTurnUpdate` whose
 *     `context.messages` is the post-compaction transcript. The agent loop
 *     uses that for the next LLM request.
 *
 * Trigger policy:
 *   - Read `costGuard.getLastInputTokens()` (the most recent assistant
 *     message's reported input token count — authoritative provider-side).
 *   - If it exceeds `thresholdTokens`, drop everything except the last
 *     `keepRecentMessages` messages.
 *
 * Compaction mode (this Phase 5):
 *   - **Truncate**: hard-drop the oldest messages, keep the recent tail.
 *     This is a safe, dependency-free simplification. Pi's full
 *     `prepareCompaction` (LLM-generated summaries stored as a
 *     `compaction` entry in the session) requires adapting `SessionEntry[]`
 *     and `fileOps`, which is not yet wired up.
 *   - The `COMPACTION` event payload carries a `mode: "truncate"` marker so
 *     the UI (and a future Phase 5.x) can tell this from a richer
 *     summary-mode compaction.
 *
 * Post-condition: the persisted event log is the source of truth. The
 * agent loop's in-memory `messages` is the only thing we replace here;
 * the JSONL log is untouched, so `replaySession()` on the next resume
 * still reconstructs the full history. Future runs resume from the
 * compacted in-memory state, not from a stale truncated log.
 */
export function makePrepareNextTurn(opts: {
  sessionId: string;
  costGuard: CostGuard;
  thresholdTokens?: number;
  keepRecentMessages?: number;
  emitEvent: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
}): (ctx: PrepareNextTurnContext) => Promise<AgentLoopTurnUpdate | undefined> {
  const threshold = opts.thresholdTokens ?? DEFAULT_COMPACTION_THRESHOLD;
  const keepRecent = opts.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;

  return async (ctx: PrepareNextTurnContext): Promise<AgentLoopTurnUpdate | undefined> => {
    const lastInput = opts.costGuard.getLastInputTokens();
    if (lastInput === null || lastInput <= threshold) {
      return undefined; // Below threshold — no compaction.
    }

    const messages = ctx.context.messages;
    if (messages.length <= keepRecent) {
      // Already short enough that further truncation would risk losing
      // the goal prompt; nothing meaningful to compact.
      return undefined;
    }

    const keptMessages = messages.slice(-keepRecent);
    const droppedCount = messages.length - keepRecent;

    // Surface compaction to the UI so the user knows the model context just
    // changed (prompt cache invalidates, behaviour may shift).
    await opts
      .emitEvent("COMPACTION", {
        mode: "truncate",
        beforeCount: messages.length,
        afterCount: keptMessages.length,
        droppedCount,
        beforeTokens: lastInput,
        threshold,
      })
      .catch(() => {
        // Emit failures must not break the loop.
      });

    const newContext: AgentContext = {
      systemPrompt: ctx.context.systemPrompt,
      messages: keptMessages,
    };
    // Preserve tools if the original context had them. exactOptionalPropertyTypes
    // forbids `tools: undefined` so we copy only when defined.
    if (ctx.context.tools !== undefined) {
      newContext.tools = ctx.context.tools;
    }

    return { context: newContext };
  };
}