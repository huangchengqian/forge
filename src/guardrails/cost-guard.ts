import type { Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";

/**
 * Budget tracking with a hard circuit breaker. Fed from assistant-message
 * usage in the agent event stream; checked by shouldStopAfterTurn.
 *
 * Also retains the most recent assistant message's `inputTokens` so the
 * prepareNextTurn hook can decide when to trigger Pi's built-in compaction.
 * The current-turn number is what matters — cumulative usage is not the
 * context window's actual size (cumulative double-counts prior turns).
 */
export class CostGuard {
  private spent: number = 0;
  private lastInputTokens: number | null = null;
  private readonly budget: number | null;

  constructor(budget: number | null) {
    this.budget = budget;
  }

  trackUsage(usage: Usage | undefined): void {
    if (!usage) return;
    const total =
      typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total)
        ? usage.cost.total
        : 0;
    this.spent += total;
    // The authoritative "context window occupied this turn" is NOT
    // `usage.input` alone: some providers (MiniMax anthropic-compat, e.g.)
    // bill the whole prompt as cacheWrite and report input=0, which would
    // permanently pin the compaction trigger to zero. Pi's
    // calculateContextTokens (totalTokens, falling back to the component
    // sum) is the same signal its own shouldCompact uses.
    const contextTokens = calculateContextTokens(usage);
    if (Number.isFinite(contextTokens) && contextTokens > 0) {
      this.lastInputTokens = contextTokens;
    }
  }

  isExhausted(): boolean {
    if (this.budget === null) return false;
    return this.spent >= this.budget;
  }

  getSpent(): number {
    return this.spent;
  }

  getRemaining(): number | null {
    if (this.budget === null) return null;
    return Math.max(0, this.budget - this.spent);
  }

  /** Most recent assistant message's input token count, or null if none seen yet. */
  getLastInputTokens(): number | null {
    return this.lastInputTokens;
  }

  /**
   * Resume from persisted session state. `spent` is mandatory (cost is
   * persisted). `lastInputTokens` is best-effort — we don't persist the
   * raw token count, so the first post-resume turn will re-populate it.
   */
  hydrate(spent: number, lastInputTokens: number | null = null): void {
    this.spent = spent;
    this.lastInputTokens = lastInputTokens;
  }
}