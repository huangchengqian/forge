export interface StuckThresholds {
  actionObservation: number; // default 4
  actionError: number; // default 4
  monologue: number; // default 4
  alternatingPattern: number; // default 6
}

const DEFAULT_THRESHOLDS: StuckThresholds = {
  actionObservation: 4,
  actionError: 4,
  monologue: 4,
  alternatingPattern: 6,
};

interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

export type StuckResult =
  | { isStuck: true; pattern: string; repetitions: number }
  | { isStuck: false };

/**
 * Detects the four looping pathologies from the ARCHITECTURE spec by
 * tracking the recent tool-call history (bounded window). Thresholds are
 * calibrated for strong models (we do not support weak models — product
 * decision 2026-09-08).
 */
export class StuckDetector {
  private history: ToolCallRecord[] = [];
  private thresholds: StuckThresholds;

  constructor(thresholds?: Partial<StuckThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  track(record: ToolCallRecord): void {
    this.history.push(record);
    if (this.history.length > 50) this.history.shift();
  }

  check(): StuckResult {
    // A stuck pattern requires the observation to repeat too: same action
    // with a *changing* result means the agent is making progress.
    const signature = (r: ToolCallRecord) =>
      JSON.stringify({ tool: r.toolName, args: r.args, result: r.result });

    // 1. Same action repeated with the same (non-error) observation.
    const lastObs = this.history.slice(-this.thresholds.actionObservation);
    if (lastObs.length >= this.thresholds.actionObservation) {
      const allSame = lastObs.every(
        (r) =>
          signature(r) === signature(lastObs[0]!) &&
          !r.isError,
      );
      if (allSame) {
        return { isStuck: true, pattern: "action_observation_loop", repetitions: lastObs.length };
      }
    }

    // 2. Same action failing with the same error, over and over.
    const lastErrors = this.history.slice(-this.thresholds.actionError);
    if (lastErrors.length >= this.thresholds.actionError) {
      const allSameError = lastErrors.every(
        (r) =>
          signature(r) === signature(lastErrors[0]!) &&
          r.isError,
      );
      if (allSameError) {
        return { isStuck: true, pattern: "action_error_loop", repetitions: lastErrors.length };
      }
    }

    // 3. Alternating pattern A→B→A→B (two actions bouncing off each other).
    if (this.history.length >= this.thresholds.alternatingPattern) {
      const recent = this.history.slice(-this.thresholds.alternatingPattern);
      const a = signature(recent[0]!);
      const b = signature(recent[1]!);
      if (a !== b) {
        const alternating = recent.every((r, i) => {
          const expected = i % 2 === 0 ? a : b;
          return signature(r) === expected;
        });
        if (alternating) {
          return { isStuck: true, pattern: "alternating_pattern", repetitions: recent.length };
        }
      }
    }

    return { isStuck: false };
  }
}
