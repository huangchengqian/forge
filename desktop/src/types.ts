/** Mirror of the server-side Session model (src/types.ts) — keep in sync. */

export type SessionStatus = "running" | "completed" | "failed" | "cancelled";
export type TrustLevel = "low" | "medium" | "high";

export interface Session {
  id: string;
  kind: "conversation" | "task";
  goal: string;
  workspace: string;
  projectId: string | null;
  model: { provider: string; modelId: string; effort?: string };
  status: SessionStatus;
  failureReason: string | null;
  cost: { total: number; budget: number | null };
  trustLevel: TrustLevel;
  maxTurns: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface ProviderConfig {
  id: string;
  api: ProviderApi;
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

export interface ForgeConfigData {
  version: number;
  providers: ProviderConfig[];
  defaultProviderId: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number;
}

/** Persisted event envelope pushed over SSE (server event-stream protocol). */
export interface EventEnvelope {
  /** Monotonic per-session sequence number; absent in raw log files. */
  seq?: string;
  type: string;
  /** Session the event belongs to (present on persisted frames and log lines). */
  taskId?: string;
  payload: {
    type?: string;
    id?: string;
    at?: number;
    [key: string]: unknown;
  };
  /** SSE frames stamp `timestamp`; the on-disk JSONL uses `at`. */
  at?: number;
  timestamp?: number;
}

/** Tool call as rendered in the conversation stream. */
export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  running: boolean;
}

/** Verification result as rendered in the VerificationPanel. */
export interface VerificationView {
  round: number;
  passed: boolean;
  reason: string | null;
}

export interface ApprovalRecordView {
  requestId: string;
  toolName: string;
  message: string;
  at: number;
}

export interface StuckWarningView {
  pattern: string;
  repetitions: number;
}

/**
 * One entry in the session transcript.
 *
 * The server streams a strictly ordered event log (MESSAGE_STARTED →
 * TEXT_DELTA* → MESSAGE_ENDED, with TOOL_CALL interleaved), so the UI keeps a
 * single ordered timeline rather than parallel message/tool arrays — otherwise
 * tool calls lose their position and multi-turn prompts lose their order.
 */
export type TimelineEntry =
  | { kind: "user"; id: string; text: string }
  /** `thinking` is true while the model is emitting reasoning but no text yet. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; thinking: boolean }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      running: boolean;
    }
  /** Session-level marker rendered in place: compaction, resume, model switch. */
  | { kind: "notice"; id: string; tone: "info" | "ok" | "warn"; icon: string; text: string };

/** Reduced view state derived from the SSE event stream. */
export interface ConversationView {
  timeline: TimelineEntry[];
  verification: VerificationView[];
  costSpent: number;
  costBudget: number | null;
  /** Updated by MODEL_CHANGED events (mid-session model switch). */
  modelId: string | null;
  /** Updated by TRUST_CHANGED events (mid-session verification switch). */
  trustLevel: TrustLevel | null;
}
