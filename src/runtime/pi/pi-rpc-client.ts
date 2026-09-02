import { createInterface } from "node:readline";
import type { PiProcess } from "./pi-process.ts";

export type PiCommand = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export type PiResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type PiEvent = {
  type: string;
  [key: string]: unknown;
};

export type EventHandler = (event: PiEvent) => void;

export type PromptResult = {
  success: boolean;
  error: string | undefined;
  events: readonly PiEvent[];
};

export class PiRpcClient {
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (r: PiResponse) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Set<EventHandler>();
  private closed = false;
  private collectedEvents: PiEvent[] = [];
  /**
   * Serialises prompt() calls against the shared Pi process. A Pi session runs
   * one agent loop at a time; concurrent prompts share this.collectedEvents
   * and the broadcast agent_settled handler, so two parallel prompts corrupt
   * each other's event buffers and both settle instantly against the wrong
   * turn (observed in real tasks: every step failed in <100ms, fix budget
   * burned on no-ops). Parallelism stays in the Forge scheduler (multiple
   * sessions); a single Pi session must prompt strictly in order.
   */
  private promptChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly proc: PiProcess) {
    const rl = createInterface({ input: proc.child.stdout! });
    rl.on("line", (line) => {
      if (!line) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    proc.child.on("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(
        `forge: Pi subprocess exited unexpectedly (code=${code}, signal=${signal})`,
      );
      for (const [, pending] of this.pending) {
        pending.reject(err);
      }
      this.pending.clear();
    });
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "response" && typeof m.command === "string") {
      const r = m as unknown as PiResponse;
      const id = r.id;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        p.resolve(r);
      }
      return;
    }
    const evt = m as PiEvent;
    this.collectedEvents.push(evt);
    for (const h of this.eventHandlers) {
      try {
        h(evt);
      } catch {}
    }
  }

  send(type: string, body: Record<string, unknown> = {}): PiResponse {
    const id = String(this.nextId++);
    const cmd: PiCommand = { id, type, ...body };
    const line = JSON.stringify(cmd) + "\n";
    this.proc.child.stdin!.write(line);
    return new Promise<PiResponse>((resolveP, reject) => {
      this.pending.set(id, { resolve: resolveP, reject });
    }) as unknown as PiResponse;
  }

  async sendAsync(type: string, body: Record<string, unknown> = {}): Promise<PiResponse> {
    const id = String(this.nextId++);
    const cmd: PiCommand = { id, type, ...body };
    const line = JSON.stringify(cmd) + "\n";
    this.proc.child.stdin!.write(line);
    return await new Promise<PiResponse>((resolveP, reject) => {
      this.pending.set(id, { resolve: resolveP, reject });
    });
  }

  /**
   * Write a command without registering a waiter. Pi resolves
   * `extension_ui_response` in rpc-mode without ever sending a response
   * message back (rpc-mode.ts: "pending.resolve(response); return;"), so a
   * waiting sendAsync would hang forever and approvals would stay pending.
   */
  fireAndForget(type: string, body: Record<string, unknown> = {}): void {
    const cmd: PiCommand = { id: String(this.nextId++), type, ...body };
    this.proc.child.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async prompt(message: string, opts: { deadlineMs?: number } = {}): Promise<PromptResult> {
    // Queue behind any in-flight prompt on the same session (see promptChain).
    const task = this.promptChain.then(() => this.doPrompt(message, opts));
    this.promptChain = task.catch(() => {});
    return task;
  }

  private async doPrompt(message: string, opts: { deadlineMs?: number }): Promise<PromptResult> {
    this.collectedEvents = [];
    const deadline = opts.deadlineMs ?? 120_000;

    let resolveSettled: () => void;
    const settledPromise = new Promise<void>((r) => { resolveSettled = r; });
    const unsub = this.onEvent((evt) => {
      if (evt.type === "agent_settled") resolveSettled();
    });

    try {
      const response = await Promise.race([
        this.sendAsync("prompt", { message }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`forge: prompt preflight deadline ${deadline}ms exceeded`)), deadline),
        ),
      ]);

      if (!response.success) {
        return { success: false, error: response.error ?? "(no error message)", events: [...this.collectedEvents] };
      }

      await Promise.race([
        settledPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`forge: agent_settled deadline ${deadline}ms exceeded`)), deadline),
        ),
      ]);

      await new Promise<void>((r) => setTimeout(r, 100));

      return { success: true, error: undefined, events: [...this.collectedEvents] };
    } finally {
      unsub();
    }
  }

  async getState(): Promise<PiResponse> {
    return await this.sendAsync("get_state");
  }

  /** Respond to a pending extension UI request (guard approval). */
  respondExtensionUI(
    id: string,
    response: { confirmed: boolean } | { value: string } | { cancelled: true },
  ): boolean {
    this.fireAndForget("extension_ui_response", { id, ...response });
    return true;
  }

  async abort(): Promise<void> {
    try {
      await this.sendAsync("abort");
    } catch {}
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolveP) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolveP();
      }, 5_000);
      this.proc.child.once("exit", () => {
        clearTimeout(timer);
        resolveP();
      });
    });
  }
}
