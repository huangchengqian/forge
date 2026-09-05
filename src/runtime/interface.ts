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

export interface AgentRuntime {
  createSession(opts: CreateSessionOptions): Promise<RuntimeSession>;
  prompt(session: RuntimeSession, message: string, opts?: PromptOptions): Promise<TurnResult>;
  /**
   * Switch the session to a different model mid-flight (steering). The
   * runtime must preserve conversation history and workspace state. Runtimes
   * that cannot switch (e.g. fake) treat this as a no-op and resolve.
   */
  setModel?(session: RuntimeSession, model: RuntimeModel): Promise<void>;
  abort(session: RuntimeSession): Promise<void>;
  destroy(session: RuntimeSession): Promise<void>;
}
