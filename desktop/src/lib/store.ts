import { create } from "zustand";
import { getCfg } from "./api.ts";
import type {
  ApprovalRecordView,
  ConversationView,
  EventEnvelope,
  Session,
  StuckWarningView,
  TrustLevel,
  VerificationView,
} from "../types.ts";

export interface DesktopState {
  sessions: Session[];
  activeSessionId: string | null;
  conversation: ConversationView;
  pendingApproval: ApprovalRecordView | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  theme: "dark" | "light";
  settingsOpen: boolean;
  diffText: string | null;

  refreshSessions: () => Promise<void>;
  select: (id: string | null) => void;
  createSession: (input: {
    goal: string;
    projectId?: string;
    trustLevel: TrustLevel;
    criteria?: Array<{ kind: string; [k: string]: unknown }>;
  }) => Promise<void>;
  steer: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  resume: (message?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  approve: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
  undo: () => Promise<void>;
  showDiff: () => Promise<void>;
  toggleTheme: () => void;
  setSettingsOpen: (open: boolean) => void;
  resetConversation: () => void;
}

const emptyConversation = (): ConversationView => ({
  messages: [],
  toolCalls: [],
  verification: [],
  costSpent: 0,
  costBudget: null,
  stuck: null,
});

let source: EventSource | null = null;
let approvalTimer: ReturnType<typeof setInterval> | null = null;

function textFromMessage(message: unknown): { role: "user" | "assistant" | null; text: string } {
  const m = message as { role?: string; content?: unknown } | undefined;
  if (!m || (m.role !== "user" && m.role !== "assistant")) return { role: null, text: "" };
  let text = "";
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        text += String((block as { text?: unknown }).text ?? "");
      }
    }
  }
  return { role: m.role, text };
}

function reduceEnvelope(state: DesktopState, env: EventEnvelope): Partial<DesktopState> {
  const conversation = { ...state.conversation };
  const payload = env.payload ?? {};
  const kind = payload.type;

  switch (env.type) {
    case "TEXT_DELTA": {
      const delta = String(payload.delta ?? "");
      const messages = [...conversation.messages];
      if (messages.length === 0 || messages[messages.length - 1]!.role !== "assistant") {
        messages.push({ role: "assistant", text: delta });
      } else {
        messages[messages.length - 1] = {
          role: "assistant",
          text: messages[messages.length - 1]!.text + delta,
        };
      }
      conversation.messages = messages;
      return { conversation };
    }

    case "MESSAGE_ENDED": {
      // Authoritative terminal text replaces streamed deltas (per message).
      const { role, text } = textFromMessage(payload.message);
      if (!role) return {};
      const messages = [...conversation.messages];
      const lastIdx = messages.length - 1;
      if (role === "assistant" && lastIdx >= 0 && messages[lastIdx]!.role === "assistant") {
        // Replace the delta-accumulated tail with the final message.
        messages[lastIdx] = { role: "assistant", text };
      } else if (role === "user") {
        // User prompts are not streamed; append if this is a new prompt.
        if (!messages.some((m) => m.role === "user" && m.text === text)) {
          const out = [...messages];
          out.unshift({ role: "user", text });
          conversation.messages = out;
          return { conversation };
        }
      }
      conversation.messages = messages;
      return { conversation };
    }

    case "TOOL_CALL": {
      conversation.toolCalls = [
        ...conversation.toolCalls,
        {
          toolCallId: String(payload.toolCallId ?? ""),
          toolName: String(payload.toolName ?? ""),
          args: payload.args,
          running: true,
        },
      ];
      return { conversation };
    }

    case "TOOL_RESULT": {
      const toolCallId = String(payload.toolCallId ?? "");
      conversation.toolCalls = conversation.toolCalls.map((t) =>
        t.toolCallId === toolCallId
          ? { ...t, result: payload.result, isError: payload.isError === true, running: false }
          : t,
      );
      return { conversation };
    }

    case "VERIFICATION_RESULT": {
      const entry: VerificationView = {
        round: Number(payload.round ?? conversation.verification.length + 1),
        passed: payload.passed === true,
        reason: typeof payload.reason === "string" ? payload.reason : null,
      };
      conversation.verification = [...conversation.verification, entry];
      return { conversation };
    }

    case "COST_UPDATE": {
      conversation.costSpent = typeof payload.spent === "number" ? payload.spent : conversation.costSpent;
      conversation.costBudget =
        typeof payload.budget === "number" ? payload.budget : conversation.costBudget;
      return { conversation };
    }

    case "STUCK_WARNING": {
      const stuck: StuckWarningView = {
        pattern: String(payload.pattern ?? "unknown"),
        repetitions: Number(payload.repetitions ?? 0),
      };
      conversation.stuck = stuck;
      return { conversation };
    }

    case "STEERING_QUEUED": {
      // kind=guard_approval_request → pull the pending dialog.
      if (payload.kind === "guard_approval_request") {
        void pollApprovals();
      }
      return {};
    }

    case "SESSION_ENDED":
    case "SESSION_FAILED":
    case "SESSION_CANCELLED": {
      void store.getState().refreshSessions();
      void pollApprovals();
      return {};
    }

    default:
      return {};
  }
}

async function pollApprovals(): Promise<void> {
  const state = store.getState();
  if (!state.activeSessionId) return;
  try {
    const { fetchApprovals } = await import("./api.ts");
    const approvals = await fetchApprovals(state.activeSessionId);
    store.setState({ pendingApproval: approvals.length > 0 ? approvals[0]! : null });
  } catch {
    /* transient */
  }
}

export const store = create<DesktopState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  conversation: emptyConversation(),
  pendingApproval: null,
  connected: false,
  loading: false,
  error: null,
  theme: (localStorage.getItem("forge-theme") as "dark" | "light") || "dark",
  settingsOpen: false,
  diffText: null,

  refreshSessions: async () => {
    const { fetchSessions } = await import("./api.ts");
    try {
      const sessions = await fetchSessions();
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  select: (id) => {
    if (source) {
      source.close();
      source = null;
    }
    if (approvalTimer) {
      clearInterval(approvalTimer);
      approvalTimer = null;
    }
    set({
      activeSessionId: id,
      conversation: emptyConversation(),
      pendingApproval: null,
      diffText: null,
      error: null,
    });
    if (!id) return;

    // SSE tail: replays persisted events, then follows live appends.
    const { baseUrl, token } = getCfg();
    source = new EventSource(`${baseUrl}/sessions/${id}/stream?token=${encodeURIComponent(token)}`);
    source.onopen = () => set({ connected: true });
    source.onerror = () => set({ connected: false });
    source.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as EventEnvelope;
        if (env.type === "AGENT_EVENT" || env.type === undefined) {
          const partial = reduceEnvelope(get(), env);
          if (Object.keys(partial).length > 0) set(partial);
        }
      } catch {
        /* skip malformed frames */
      }
    };

    // Approval dialogs while the session runs.
    approvalTimer = setInterval(() => void pollApprovals(), 2500);
    void pollApprovals();
  },

  createSession: async (input) => {
    const { createSession: create } = await import("./api.ts");
    set({ loading: true, error: null });
    try {
      const { sessionId } = await create(input);
      await get().refreshSessions();
      get().select(sessionId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  steer: async (message) => {
    const id = get().activeSessionId;
    if (!id || !message.trim()) return;
    const { steerSession } = await import("./api.ts");
    await steerSession(id, message.trim());
  },

  abort: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    const { abortSession } = await import("./api.ts");
    await abortSession(id);
  },

  resume: async (message) => {
    const id = get().activeSessionId;
    if (!id) return;
    const { resumeSession } = await import("./api.ts");
    set({ error: null });
    try {
      await resumeSession(id, message);
      // SSE session_started will drive the running state; just nudge the
      // sessions list so the row's status badge updates.
      await get().refreshSessions();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  remove: async (id) => {
    const { deleteSession } = await import("./api.ts");
    await deleteSession(id);
    if (get().activeSessionId === id) get().select(null);
    await get().refreshSessions();
  },

  approve: async (requestId) => {
    const id = get().activeSessionId;
    if (!id) return;
    const { resolveApproval } = await import("./api.ts");
    await resolveApproval(id, requestId, "approve");
    set({ pendingApproval: null });
    void pollApprovals();
  },

  deny: async (requestId) => {
    const id = get().activeSessionId;
    if (!id) return;
    const { resolveApproval } = await import("./api.ts");
    await resolveApproval(id, requestId, "deny");
    set({ pendingApproval: null });
    void pollApprovals();
  },

  undo: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    const { undoSession } = await import("./api.ts");
    await undoSession(id);
    set({ diffText: null });
  },

  showDiff: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    const { fetchDiff } = await import("./api.ts");
    const diff = await fetchDiff(id);
    if (diff.kind === "git" && diff.diff) {
      set({ diffText: diff.diff });
    } else if (diff.files) {
      set({ diffText: diff.files.map((f) => `${f.backup ? "M" : "+"} ${f.path}`).join("\n") });
    } else {
      set({ diffText: "(no changes)" });
    }
  },

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem("forge-theme", next);
    set({ theme: next });
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  resetConversation: () => set({ conversation: emptyConversation() }),
}));

// Alias matching the previous hook name for minimal import churn.
export const useDesktopStore = store;
