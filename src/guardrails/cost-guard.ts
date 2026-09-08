import type { Usage } from "@earendil-works/pi-ai";

/**
 * Budget tracking with a hard circuit breaker. Fed from assistant-message
 * usage in the agent event stream; checked by shouldStopAfterTurn.
 */
export class CostGuard {
  private spent: number = 0;
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
}
