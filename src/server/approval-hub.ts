/**
 * ApprovalHub — in-memory registry of guard approvals.
 *
 * The guard pipeline (beforeToolCall hook) hits an `ask` decision for bash /
 * network / git calls. The hook blocks on `request()`; the Desktop resolves
 * it via the HTTP approve/deny endpoints which call `mark()`. A hard timeout
 * converts an unanswered dialog into a denial — an agent must never hang
 * forever on an unattended dialog.
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalRecord = {
  requestId: string;
  taskId: string;
  method: string;
  title: string;
  message: string;
  at: number;
  status: ApprovalStatus;
};

type Waiter = (approved: boolean) => void;

export class ApprovalHub {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly byTask = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, Waiter>();

  record(input: { requestId: string; taskId: string; method: string; title: string; message: string; at: number }): void {
    this.records.set(input.requestId, { ...input, status: "pending" });
    const set = this.byTask.get(input.taskId) ?? new Set<string>();
    set.add(input.requestId);
    this.byTask.set(input.taskId, set);
  }

  /** Pending approvals for a task (oldest first). */
  listPending(taskId: string): readonly ApprovalRecord[] {
    const ids = this.byTask.get(taskId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.records.get(id))
      .filter((r): r is ApprovalRecord => !!r && r.status === "pending")
      .sort((a, b) => a.at - b.at);
  }

  get(requestId: string): ApprovalRecord | null {
    return this.records.get(requestId) ?? null;
  }

  mark(requestId: string, status: ApprovalStatus): boolean {
    const rec = this.records.get(requestId);
    if (!rec) return false;
    this.records.set(requestId, { ...rec, status });
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      this.waiters.delete(requestId);
      waiter(status === "approved");
    }
    return true;
  }

  /**
   * Blocking approval request used by the guardrail hook. Registers a pending
   * record and resolves when mark() lands (approved/denied) or on timeout
   * (counts as denied — never hang on an unattended dialog).
   */
  request(input: {
    requestId: string;
    taskId: string;
    toolName: string;
    input: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<boolean> {
    const timeoutMs = input.timeoutMs ?? 5 * 60_000;
    this.record({
      requestId: input.requestId,
      taskId: input.taskId,
      method: "tool_call",
      title: `Allow ${input.toolName}?`,
      message: JSON.stringify(input.input).slice(0, 500),
      at: Date.now(),
    });

    return new Promise<boolean>((resolveP) => {
      const settle = (approved: boolean) => {
        clearTimeout(timer);
        resolveP(approved);
      };
      const waiter: Waiter = settle;
      this.waiters.set(input.requestId, waiter);
      const timer = setTimeout(() => {
        if (this.waiters.get(input.requestId) === waiter) {
          this.waiters.delete(input.requestId);
          this.mark(input.requestId, "expired");
          resolveP(false);
        }
      }, timeoutMs);
    });
  }
}
