export type RuntimeModel = {
  provider: string;
  modelId: string;
};

export type RuntimeSession = {
  id: string;
  taskId: string;
  directory: string;
};

export type PromptOptions = {
  deadlineMs?: number;
  /** Image attachments for this turn (base64 payloads). */
  images?: RuntimeImage[];
};

/** An image attachment sent to the model. `data` is base64, no data: prefix. */
export type RuntimeImage = {
  mimeType: string;
  data: string;
};

export type TurnResult = {
  success: boolean;
  text: string;
  error: string | undefined;
};

export type CreateSessionOptions = {
  taskId: string;
  goal: string;
  /**
   * Exact working directory for the session. The adapter MUST use it as-is
   * and MUST NOT derive or append a subdirectory. The caller owns creation
   * and lifecycle of this directory; the adapter must never delete it.
   */
  workspace: string;
  model: RuntimeModel;
  env: Record<string, string> | undefined;
};

/** Live runtime facts for a session, as reported by getRuntimeState. */
export type RuntimeState = {
  effort?: string | undefined;
  contextWindow?: number | undefined;
};

export interface AgentRuntime {
  createSession(opts: CreateSessionOptions): Promise<RuntimeSession>;
  prompt(session: RuntimeSession, message: string, opts?: PromptOptions): Promise<TurnResult>;
  /**
   * Deliver a mid-run steering message to a session that is currently
   * executing a prompt. The runtime queues it with the agent; it is consumed
   * at the next turn boundary without ending the in-flight run. Only called
   * while the session is known-active; delivering to an idle session is not
   * defined. Runtimes without steering support omit this method.
   */
  steer?(session: RuntimeSession, message: string, images?: RuntimeImage[]): Promise<void>;
  /** Reasoning-effort levels the session's model supports. */
  getEffortOptions?(session: RuntimeSession): Promise<string[]>;
  /** Set the reasoning effort for subsequent turns. Levels are model-specific. */
  setEffort?(session: RuntimeSession, level: string): Promise<void>;
  /**
   * Live runtime facts for the session: current effort and the model's
   * context window size (tokens). Backs the desktop context gauge.
   */
  getRuntimeState?(session: RuntimeSession): Promise<RuntimeState>;
  /**
   * Manually compact the session context. Runtimes without compaction omit
   * this method.
   */
  compact?(session: RuntimeSession, instructions?: string): Promise<void>;
  /**
   * Switch the session to a different model mid-flight (steering). The
   * runtime must preserve conversation history and workspace state. Runtimes
   * that cannot switch (e.g. fake) treat this as a no-op and resolve.
   */
  setModel?(session: RuntimeSession, model: RuntimeModel): Promise<void>;
  abort(session: RuntimeSession): Promise<void>;
  destroy(session: RuntimeSession): Promise<void>;
}
