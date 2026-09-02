/**
 * ApprovalHub — in-memory registry of pending guard approvals (9.6.5).
 *
 * The guard extension (inside the Pi subprocess) emits extension_ui_request
 * events on `ask` decisions. PiRuntime surfaces them here via its approval
 * listener; the HTTP layer lists them for the Desktop and resolves them by
 * calling back into the runtime.
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

export class ApprovalHub {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly byTask = new Map<string, Set<string>>();

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
    return true;
  }
}
