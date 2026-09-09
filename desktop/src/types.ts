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
  seq?: string;
  type: string;
  payload: {
    type?: string;
    id?: string;
    at?: number;
    [key: string]: unknown;
  };
  at?: number;
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

/** Reduced view state derived from the SSE event stream. */
export interface ConversationView {
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  toolCalls: ToolCallView[];
  verification: VerificationView[];
  costSpent: number;
  costBudget: number | null;
  stuck: StuckWarningView | null;
  /** Last compaction seen on the stream (mode: "llm-summary" | "truncate"). */
  compaction: { mode: string; at: number } | null;
  /** Set when the stream replays a SESSION_RESUMED marker. */
  resumed: { messagesRecovered: number } | null;
}
