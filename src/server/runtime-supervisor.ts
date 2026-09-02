export type SettleClassification = "normal" | "runtime_lost";

export class RuntimeSupervisor {
  private tracked = new Map<string, { startedAt: number }>();

  constructor(private readonly log: (msg: string) => void) {}

  track(taskId: string): void {
    this.tracked.set(taskId, { startedAt: Date.now() });
    this.log(`tracking ${taskId}`);
  }

  settled(taskId: string, state: string, failureReason: string | null): void {
    this.tracked.delete(taskId);
    if (state === "FAILED" && failureReason && /exited|spawn error|EPIPE|subprocess/i.test(failureReason)) {
      this.log(`${taskId} FAILED with runtime-lost signature: ${failureReason}`);
      this.log(`${taskId} recommend POST /tasks/${taskId}/resume to recreate runtime session`);
      return;
    }
    this.log(`${taskId} settled ${state}`);
  }

  reportCrash(taskId: string, err: unknown): void {
    this.log(`${taskId} orchestrator crashed: ${err instanceof Error ? err.message : String(err)}`);
    this.log(`${taskId} recoverable via POST /tasks/${taskId}/resume`);
  }

  listActive(): readonly string[] {
    return Array.from(this.tracked.keys());
  }
}
