import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentRuntime,
  CreateSessionOptions,
  PromptOptions,
  RuntimeModel,
  RuntimeSession,
  TurnResult,
} from "../interface.ts";
import { PiRpcClient, type PiEvent } from "./pi-rpc-client.ts";
import { spawnPi, type PiProcess } from "./pi-process.ts";
import { GUARD_ENTRY_PATH } from "../../guard/index.ts";

type PiRuntimeSession = RuntimeSession & {
  client: PiRpcClient;
  proc: PiProcess;
};

/** A pending human-approval request surfaced from the guard extension. */
export type ApprovalRequest = {
  requestId: string;
  taskId: string;
  method: string;
  title: string;
  message: string;
  at: number;
};

export type ApprovalListener = (request: ApprovalRequest) => void;

export type PiRuntimeOptions = {
  /** Receives guard approval requests from the extension (relay to the UI). */
  onApprovalRequest?: ApprovalListener;
  /** Forge-owned Pi agent dir (custom models.json); set when a provider is configured. */
  piAgentDir?: string;
  /**
   * Streams every raw Pi event (agent message deltas, tool calls, tool
   * execution updates) to Forge so the desktop can render a live, Codex-style
   * conversation. Defaults to a no-op (headless CLI runs ignore it).
   */
  onPiEvent?: (taskId: string, event: PiEvent) => void;
};

export class PiRuntime implements AgentRuntime {
  /** Maps extension UI request id → owning client, for resolveApproval. */
  private readonly approvalClients = new Map<string, PiRpcClient>();

  constructor(
    private readonly forgeHome: string,
    private readonly options: PiRuntimeOptions = {},
  ) {}

  async createSession(opts: CreateSessionOptions): Promise<RuntimeSession> {
    const directory = resolve(opts.workspace);
    // Idempotent no-op when the directory already exists. The caller owns the
    // directory lifecycle (see the interface contract on CreateSessionOptions).
    await mkdir(directory, { recursive: true });
    const proc = await spawnPi({
      directory,
      provider: opts.model.provider,
      modelId: opts.model.modelId,
      env: {
        ...opts.env,
        // With an approval listener wired (server path), `ask` blocks until the
        // Desktop answers. Headless CLI runs (no listener) treat ask as allow.
        FORGE_GUARD_ASK_FALLBACK: this.options.onApprovalRequest ? "block" : "allow",
        // Undo journal location for guard file-tool backups.
        FORGE_UNDO_DIR: join(this.forgeHome, "undo", opts.taskId),
        // Custom-provider models.json lives in a Forge-owned agent dir.
        ...(this.options.piAgentDir ? { PI_CODING_AGENT_DIR: this.options.piAgentDir } : {}),
      },
      extensions: [GUARD_ENTRY_PATH],
    });

    const client = new PiRpcClient(proc);
    client.onEvent((evt) => {
      // Stream every Pi event out for the desktop conversation view.
      this.options.onPiEvent?.(opts.taskId, evt);
      if (evt.type !== "extension_ui_request") return;
      const m = evt as { id?: string; method?: string; title?: string; message?: string };
      if (!m.id || !m.method) return;
      this.approvalClients.set(m.id, client);
      this.options.onApprovalRequest?.({
        requestId: m.id,
        taskId: opts.taskId,
        method: m.method,
        title: m.title ?? "",
        message: m.message ?? "",
        at: Date.now(),
      });
    });
    const state = await client.getState();
    if (!state.success || !state.data) {
      await client.close();
      throw new Error(`runtime failed to boot: ${state.error ?? "unknown"}`);
    }
    const data = state.data as { sessionId?: string };
    const session: PiRuntimeSession = {
      id: data.sessionId ?? "unknown",
      taskId: opts.taskId,
      directory,
      client,
      proc,
    };
    return session;
  }

  /**
   * Resolve a pending guard approval (confirmed = allow, else block).
   * Concrete-class method; NOT part of the frozen AgentRuntime interface.
   */
  async resolveApproval(requestId: string, confirmed: boolean): Promise<boolean> {
    const client = this.approvalClients.get(requestId);
    if (!client) return false;
    this.approvalClients.delete(requestId);
    // fire-and-forget: Pi resolves extension_ui_response without replying
    client.respondExtensionUI(requestId, confirmed ? { confirmed: true } : { confirmed: false });
    return true;
  }

  async prompt(
    session: RuntimeSession,
    message: string,
    opts?: PromptOptions,
  ): Promise<TurnResult> {
    const pi = session as PiRuntimeSession;
    const deadline = opts?.deadlineMs ?? undefined;
    const result = await pi.client.prompt(message, deadline !== undefined ? { deadlineMs: deadline } : undefined);
    if (!result.success) {
      return {
        success: false,
        text: "",
        error: result.error,
      };
    }
    return {
      success: true,
      text: lastAssistantText(result.events),
      error: undefined,
    };
  }

  async setModel(session: RuntimeSession, model: RuntimeModel): Promise<void> {
    const pi = session as PiRuntimeSession;
    await pi.client.setModel(model.provider, model.modelId);
  }

  async abort(session: RuntimeSession): Promise<void> {
    const pi = session as PiRuntimeSession;
    await pi.client.abort();
  }

  async destroy(session: RuntimeSession): Promise<void> {
    const pi = session as PiRuntimeSession;
    // RED LINE (docs/16 §3): destroy owns the PROCESS lifecycle only. It must
    // never touch the filesystem — in in-place mode the session directory is
    // the user's real project. Deleting it is a data-loss incident.
    await pi.client.close();
  }
}

export function lastAssistantText(events: readonly PiEvent[]): string {
  // Historical note: delta reordering was once attributed to the runtime's
  // streaming adapter, but the real cause was Forge's own event persistence
  // (fire-and-forget appends racing in the libuv threadpool — fixed with a
  // per-task FIFO queue in event-log.ts). Runtime deltas were never
  // corrupted. Preferring `message_end` text is kept as defense in depth:
  // it reflects the runtime's complete in-memory message even if an older
  // runtime or transport ever mangles deltas, and it covers aborted turns.
  let deltaBuf = "";
  let finalText: string | null = null;
  for (const e of events) {
    if (e.type === "message_update") {
      const evt = e as { assistantMessageEvent?: { type?: string; delta?: string } };
      if (evt.assistantMessageEvent?.type === "text_delta") {
        deltaBuf += evt.assistantMessageEvent.delta ?? "";
      }
    } else if (e.type === "message_end") {
      const text = assistantTextBlocks(e);
      if (text !== null) finalText = text;
    }
  }
  return finalText ?? deltaBuf;
}

/**
 * Extract the concatenated text-block content of an assistant message_end
 * event. Returns null for non-assistant messages, missing content, or
 * messages without any text (e.g. a tool-call-only turn) — callers keep the
 * previously captured text in those cases.
 */
function assistantTextBlocks(e: PiEvent): string | null {
  const msg = (e as { message?: unknown }).message as
    | { role?: string; content?: unknown }
    | undefined;
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return null;
  let text = "";
  for (const block of msg.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text"
    ) {
      text += (block as { text?: string }).text ?? "";
    }
  }
  return text.length > 0 ? text : null;
}
