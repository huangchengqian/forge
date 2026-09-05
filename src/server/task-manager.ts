import type { AgentRuntime, RuntimeSession } from "../runtime/interface.ts";
import { PiRuntime } from "../runtime/pi/index.ts";
import { FakeRuntime } from "../runtime/fake-runtime.ts";
import { EventBus } from "../events/index.ts";
import { access, constants, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  attachTask,
  newTaskId,
  runOrchestrator,
  startTask,
} from "../orchestrator/index.ts";
import { extractTemplateVars } from "../orchestrator/llm-planner.ts";
import { isTerminal } from "../core/state/task-state.ts";
import { listTasks, loadTask, saveTask, deleteTask } from "../core/persistence/task-store.ts";
import { appendEvent, eventsDir, readEvents } from "../core/persistence/event-log.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { RuntimeSupervisor } from "./runtime-supervisor.ts";
import { TaskRecoveryService } from "../recovery/index.ts";
import { loadForgeConfig, resolveProvider } from "./config-store.ts";
import type { ProjectsRegistry, ProjectRecord } from "./projects.ts";
import type { ApprovalHub, ApprovalRecord } from "./approval-hub.ts";
import { captureGitHead } from "./undo.ts";
import { appendRule, ruleFromApproval } from "../guard/policy.ts";
import { syncCustomModels, piAgentDir, providerName } from "./pi-models.ts";
import {
  classifyIntent,
  conversationReply,
  endpointFromConfig,
  replayConversationHistory,
  type ChatMessage,
  type IntentResult,
} from "./intent-router.ts";

/** Typed error so the HTTP layer can map create/resume failures to status codes. */
export class CreateTaskError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Maps a built-in Pi provider name (used only on the unconfigured headless
// path) to its API key env var. Configured providers never hit this — their
// key lives in Forge's models.json.
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GEMINI_API_KEY"],
};

export function providerEnvVar(provider: string): string | null {
  return PROVIDER_ENV_VARS[provider]?.[0] ?? null;
}

export type ServerRuntimeKind = "pi" | "fake";

export type TaskManagerOptions = {
  bus: EventBus;
  forgeHome: string;
  runtimeKind: ServerRuntimeKind;
  defaultProvider: string;
  defaultModelId: string;
  maxConcurrency: number | undefined;
  supervisor: RuntimeSupervisor;
  projects: ProjectsRegistry;
  approvalHub: ApprovalHub;
  /** Injectable Phase 9.7 router (tests); defaults to the server mini completion. */
  intentRouter?: { classify: (input: string) => Promise<IntentResult> };
};

type ActiveEntry = {
  taskId: string;
  session: RuntimeSession;
  runtime: AgentRuntime;
  runPromise: Promise<TaskSession>;
  /** Resolved workspace lock key; released when the task leaves the active set. */
  workspaceKey: string;
};

export type PreflightResult = {
  ok: boolean;
  workspace: {
    path: string;
    source: "project" | "fallback";
    name: string | null;
    exists: boolean;
    writable: boolean;
  };
  provider: { kind: string; modelId: string; envConfigured: boolean; envVar: string | null };
  lock: { key: string; available: boolean; holder: string | null };
  problems: string[];
};

export function resolveProviderEnv(provider: string): Record<string, string> | undefined {
  const names = PROVIDER_ENV_VARS[provider];
  if (!names) return undefined;
  for (const n of names) {
    if (process.env[n]) return { [n]: process.env[n]! };
  }
  return undefined;
}

export class TaskManager {
  private active = new Map<string, ActiveEntry>();
  /** Settled sessions whose Pi process is kept alive for continued conversation (steering). */
  private idle = new Map<string, ActiveEntry>();
  /** Advisory per-workspace lock: resolved absolute path → taskId. In-memory only. */
  private workspaceLocks = new Map<string, string>();
  readonly recovery = new TaskRecoveryService();

  constructor(private readonly opts: TaskManagerOptions) {}

  private async buildRuntime(provider: string, modelId: string, goal: string): Promise<AgentRuntime> {
    if (this.opts.runtimeKind === "fake") {
      const vars = extractTemplateVars(goal);
      const rt = new FakeRuntime(this.opts.forgeHome, {
        steps: [
          {
            intent: goal,
            criteria: [{ kind: "file_exists", path: vars.path ?? "output.txt" }],
          },
        ],
      });
      const delay = Number(process.env.FORGE_FAKE_DELAY_MS ?? 0);
      if (delay > 0) {
        const orig = rt.prompt.bind(rt);
        rt.prompt = async (session, message, promptOpts) => {
          await new Promise<void>((r) => setTimeout(r, delay));
          return orig(session, message, promptOpts);
        };
      }
      return rt;
    }
    void modelId;
    // Any configured provider is declared in Forge's pi-agent models.json;
    // Pi spawns with --provider custom and a Forge-owned agent dir. Only the
    // unconfigured (headless CLI) path falls back to a built-in provider +
    // env-injected key.
    const custom = await this.hasConfiguredProvider();
    const options: import("../runtime/pi/index.ts").PiRuntimeOptions = {
      onApprovalRequest: (req) => {
        this.opts.approvalHub.record({
          requestId: req.requestId,
          taskId: req.taskId,
          method: req.method,
          title: req.title,
          message: req.message,
          at: req.at,
        });
      },
      onPiEvent: (taskId, event) => {
        // Stream raw Pi events (agent messages, tool calls) into the task's
        // persisted event log so the desktop SSE can render a live conversation.
        void appendEvent(taskId, "AGENT_EVENT", { piEvent: event });
      },
    };
    if (custom) options.piAgentDir = piAgentDir(this.opts.forgeHome);
    return new PiRuntime(this.opts.forgeHome, options);
  }

  private async hasConfiguredProvider(): Promise<boolean> {
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    return resolveProvider(cfg) !== null;
  }

  // --- workspace resolution & locking ---

  /** Explicit projectId wins; otherwise the task inherits the active project. */
  private async resolveProject(projectId: string | undefined): Promise<ProjectRecord | null> {
    if (projectId) {
      const p = await this.opts.projects.get(projectId);
      if (!p) throw new CreateTaskError(400, `no such project: ${projectId}`);
      return p;
    }
    return this.opts.projects.active();
  }

  private async validateProjectWorkspace(path: string): Promise<void> {
    let st;
    try {
      st = await stat(path);
    } catch {
      throw new CreateTaskError(400, `project directory does not exist: ${path}`);
    }
    if (!st.isDirectory()) {
      throw new CreateTaskError(400, `workspace is not a directory: ${path}`);
    }
    try {
      await access(path, constants.W_OK);
    } catch {
      throw new CreateTaskError(400, `workspace is not writable: ${path}`);
    }
  }

  private acquireLock(key: string, taskId: string): void {
    const holder = this.workspaceLocks.get(key);
    if (holder && holder !== taskId && this.active.has(holder)) {
      throw new CreateTaskError(409, `workspace is busy: task ${holder} is running in ${key}`);
    }
    this.workspaceLocks.set(key, taskId);
  }

  private releaseLock(key: string, taskId: string): void {
    if (this.workspaceLocks.get(key) === taskId) this.workspaceLocks.delete(key);
  }

  private release(taskId: string): void {
    const entry = this.active.get(taskId);
    if (entry) this.releaseLock(entry.workspaceKey, taskId);
    this.active.delete(taskId);
  }

  /**
   * Fast-fail when no provider credentials are reachable (audit B3): without
   * this, Pi boots, the first prompt fails, and the task burns its whole FIX
   * budget on a guaranteed-fail path before surfacing an opaque error.
   */
  private requireProviderEnv(provider: string, env: Record<string, string>): void {
    if (this.opts.runtimeKind !== "pi") return;
    if (Object.keys(env).length > 0) return;
    const envVar = providerEnvVar(provider) ?? "the provider's API key env var";
    throw new CreateTaskError(
      400,
      `no API key configured for provider '${provider}' — set ${envVar} or add a provider in Settings`,
    );
  }

  // --- public API ---

  /**
   * Phase 9.7 entry point. The FIRST message of every session is routed by
   * the Intent Router (server-side mini completion, no Pi runtime):
   *   - "conversation" → a plain chat record, answered in a single model call.
   *   - "task" → the existing engineering pipeline below, untouched.
   */
  async create(input: {
    goal: string;
    provider?: string;
    modelId?: string;
    providerId?: string;
    maxConcurrency?: number;
    projectId?: string;
  }): Promise<{ taskId: string }> {
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const endpoint = endpointFromConfig(cfg);
    // Empty goals cannot be classified; keep the legacy pipeline's behavior.
    let intent: IntentResult;
    if (this.opts.intentRouter) {
      intent = await this.opts.intentRouter.classify(input.goal);
    } else if (endpoint && input.goal?.trim()) {
      intent = await classifyIntent(endpoint, input.goal);
    } else {
      intent = { kind: "task" };
    }
    if (intent.kind === "conversation") {
      return this.createConversation(input, cfg, intent.reply);
    }
    return this.createEngineeringTask(input);
  }

  /**
   * Conversation path: no workspace lock, no git head capture, no Pi runtime,
   * no task workspace, no state machine. The router already produced the
   * reply; we persist a lightweight kind=conversation record and stream the
   * reply into its event log so the desktop renders it like any agent text.
   */
  private async createConversation(
    input: { goal: string; projectId?: string },
    cfg: Awaited<ReturnType<typeof loadForgeConfig>>,
    reply: string,
  ): Promise<{ taskId: string }> {
    const project = await this.resolveProject(input.projectId);
    const taskId = newTaskId();
    const workspace = project
      ? resolve(project.path)
      : join(this.opts.forgeHome, "tasks", taskId);
    const now = Date.now();
    const subscription = resolveProvider(cfg);
    const provider = subscription ? providerName(subscription) : this.opts.defaultProvider;
    const modelId = subscription?.modelId ?? this.opts.defaultModelId;
    const task: TaskSession = {
      id: taskId,
      goal: input.goal.trim(),
      state: "COMPLETE",
      kind: "conversation",
      plan: null,
      currentStepId: null,
      observations: [],
      runtime: null,
      piSessionId: null,
      directory: workspace,
      workspacePath: project ? workspace : null,
      projectId: project?.id ?? null,
      model: { provider, modelId },
      fixCount: 0,
      createdAt: now,
      updatedAt: now,
      failureReason: null,
      lastEvaluation: null,
    };
    await saveTask(task);
    await appendEvent(taskId, "TASK_CREATED", { goal: task.goal, modelProvider: provider, modelId });
    // Assistant reply, framed as the Pi text event the desktop renders as an
    // agent message. The opening user message is NOT duplicated here — the
    // session view renders the goal as the user block already.
    await appendEvent(taskId, "AGENT_EVENT", {
      piEvent: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: reply },
      },
    });
    await appendEvent(taskId, "TASK_COMPLETED", { observations: 0 });
    return { taskId };
  }

  /**
   * Engineering path: the unchanged pre-Phase-9.7 pipeline. The router has
   * already decided this is a task; everything below runs exactly as before
   * (lock → git head → runtime → orchestrator).
   */
  async createEngineeringTask(input: {
    goal: string;
    provider?: string;
    modelId?: string;
    providerId?: string;
    maxConcurrency?: number;
    projectId?: string;
  }): Promise<{ taskId: string }> {
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription = resolveProvider(cfg, input.providerId);
    const modelId = input.modelId ?? subscription?.modelId ?? this.opts.defaultModelId;
    // Configured subscription → declared in models.json (apiKey lives there),
    // spawned as `--provider <subscription id>`; unconfigured → built-in
    // provider with an env-injected key.
    let provider: string;
    let env: Record<string, string> = {};
    if (subscription) {
      await syncCustomModels(this.opts.forgeHome, cfg.providers);
      provider = providerName(subscription);
    } else {
      provider = input.provider ?? this.opts.defaultProvider;
      env = resolveProviderEnv(provider) ?? {};
      this.requireProviderEnv(provider, env);
    }

    const project = await this.resolveProject(input.projectId);
    const taskId = newTaskId();
    const workspace = project
      ? resolve(project.path)
      : join(this.opts.forgeHome, "tasks", taskId);
    if (project) await this.validateProjectWorkspace(workspace);

    const workspaceKey = resolve(workspace);
    this.acquireLock(workspaceKey, taskId);
    // Baseline for the diff view: capture git HEAD BEFORE the agent runs.
    await captureGitHead(this.opts.forgeHome, taskId, workspace);

    let handle: Awaited<ReturnType<typeof startTask>>;
    try {
      const runtime = await this.buildRuntime(provider, modelId, input.goal);
      handle = await startTask({
        runtime,
        taskId,
        provider,
        modelId,
        env,
        eventBus: this.opts.bus,
        deadlineMs: undefined,
        policy: undefined,
        workspace,
        ...(input.maxConcurrency ?? this.opts.maxConcurrency) !== undefined
          ? { maxConcurrency: (input.maxConcurrency ?? this.opts.maxConcurrency)! }
          : {},
      });
    } catch (err) {
      this.releaseLock(workspaceKey, taskId);
      throw err;
    }
    handle.task.goal = input.goal;
    handle.task.projectId = project?.id ?? null;
    await saveTask(handle.task);

    const session = handle.session;
    const runPromise = runOrchestrator(handle)
      .then((final) => {
        this.settle(taskId, final);
        return final;
      })
      .catch((err) => {
        this.release(taskId);
        this.opts.supervisor.reportCrash(taskId, err);
        throw err;
      });
    this.active.set(taskId, { taskId, session, runtime: handle.runtime, runPromise, workspaceKey });
    this.opts.supervisor.track(taskId);
    return { taskId };
  }

  async preflight(input: {
    projectId?: string;
    provider?: string;
    modelId?: string;
    providerId?: string;
  }): Promise<PreflightResult> {
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription = resolveProvider(cfg, input.providerId);
    const provider = input.provider ?? (subscription ? providerName(subscription) : this.opts.defaultProvider);
    const modelId = input.modelId ?? subscription?.modelId ?? this.opts.defaultModelId;
    const problems: string[] = [];

    let project: ProjectRecord | null = null;
    try {
      project = await this.resolveProject(input.projectId);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }

    // Without a project the task runs in the default per-task directory, which
    // Forge creates at start — the parent dir is what matters for writability.
    const workspacePath = project
      ? resolve(project.path)
      : join(this.opts.forgeHome, "tasks");
    let exists = false;
    let writable = false;
    try {
      exists = (await stat(workspacePath)).isDirectory();
    } catch {}
    if (exists) {
      try {
        await access(workspacePath, constants.W_OK);
        writable = true;
      } catch {
        problems.push(`workspace is not writable: ${workspacePath}`);
      }
    } else if (project) {
      problems.push(`project directory does not exist: ${workspacePath}`);
    }

    const lockKey = resolve(workspacePath);
    const holder = this.workspaceLocks.get(lockKey) ?? null;
    const lockAvailable = !holder || !this.active.has(holder);
    if (!lockAvailable) {
      problems.push(`workspace is busy: task ${holder} is running in ${lockKey}`);
    }

    const env = subscription ? {} : (resolveProviderEnv(provider) ?? {});
    const envConfigured = subscription !== null || Object.keys(env).length > 0;
    const envVar = providerEnvVar(provider);
    if (this.opts.runtimeKind === "pi" && !envConfigured) {
      problems.push(
        `no API key configured for provider '${provider}' — set ${envVar ?? "its API key env var"} or add a provider in Settings`,
      );
    }
    if (!modelId?.trim()) {
      problems.push("no model configured — choose a model in Settings or pass modelId");
    }

    return {
      ok: problems.length === 0,
      workspace: {
        path: workspacePath,
        source: project ? "project" : "fallback",
        name: project?.name ?? null,
        exists,
        writable,
      },
      provider: { kind: provider, modelId, envConfigured, envVar },
      lock: { key: lockKey, available: lockAvailable, holder },
      problems,
    };
  }

  async resume(taskId: string): Promise<{ resumed: boolean; message: string }> {
    if (this.active.has(taskId)) {
      return { resumed: false, message: "task already running" };
    }
    const decision = await this.recovery.inspect(taskId);
    if (decision.kind === "not_found") {
      return { resumed: false, message: "no such task" };
    }
    if (decision.kind === "already_completed") {
      return { resumed: false, message: `task already ${decision.task.state}` };
    }
    if (decision.kind === "failed") {
      return { resumed: false, message: `task terminal ${decision.task.state}: ${decision.reason}` };
    }
    if (decision.kind === "invalid") {
      return { resumed: false, message: `invalid task state: ${decision.reason}` };
    }

    const task = decision.task;
    // A-2 migration guard: legacy v2 tasks (migrated workspacePath === null)
    // ran in the retired sandbox model and are display-only. Only hand-crafted
    // in-memory sessions without the field (undefined) are exempt so demos and
    // recovery tests keep working.
    if (task.workspacePath === null) {
      return {
        resumed: false,
        message:
          "task predates schema v3 (no workspace binding); resume is unsupported after A-2 — create a new task for this goal",
      };
    }
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription = resolveProvider(cfg);
    if (subscription) {
      await syncCustomModels(this.opts.forgeHome, cfg.providers);
    }
    const workspace = task.workspacePath?.trim()
      ? resolve(task.workspacePath)
      : task.directory?.trim()
        ? resolve(task.directory)
        : join(this.opts.forgeHome, "tasks", taskId);
    const workspaceKey = resolve(workspace);
    try {
      this.acquireLock(workspaceKey, taskId);
    } catch (err) {
      return { resumed: false, message: err instanceof Error ? err.message : String(err) };
    }

    const provider = subscription ? providerName(subscription) : task.model.provider;
    const modelId = subscription ? subscription.modelId : task.model.modelId;
    let handle: Awaited<ReturnType<typeof attachTask>>;
    try {
      const runtime = await this.buildRuntime(provider, modelId, task.goal);
      handle = await attachTask({
        runtime,
        taskId,
        provider,
        modelId,
        env: subscription ? {} : (resolveProviderEnv(provider) ?? {}),
        eventBus: this.opts.bus,
        deadlineMs: undefined,
        policy: undefined,
        ...this.opts.maxConcurrency !== undefined ? { maxConcurrency: this.opts.maxConcurrency } : {},
      });
    } catch (err) {
      this.releaseLock(workspaceKey, taskId);
      return { resumed: false, message: `attach failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!handle) {
      this.releaseLock(workspaceKey, taskId);
      return { resumed: false, message: "attach failed" };
    }

    const session = handle.session;
    const runPromise = runOrchestrator(handle)
      .then((final) => {
        this.settle(taskId, final);
        return final;
      })
      .catch((err) => {
        this.release(taskId);
        this.opts.supervisor.reportCrash(taskId, err);
        throw err;
      });
    this.active.set(taskId, { taskId, session, runtime: handle.runtime, runPromise, workspaceKey });
    this.opts.supervisor.track(taskId);

    const planInfo = await this.recovery.plan(taskId);
    const lost = planInfo?.runtimeSessionLost ? " (runtime session recreated)" : "";
    return { resumed: true, message: `resumed from ${task.state}${lost}` };
  }

  async cancel(taskId: string): Promise<{ cancelled: boolean; message: string }> {
    const t = await loadTask(taskId);
    if (!t) return { cancelled: false, message: "no such task" };
    if (isTerminal(t.state)) {
      return { cancelled: false, message: `task already ${t.state}` };
    }
    const rec = this.active.get(taskId);
    if (!rec) {
      return { cancelled: false, message: "task not active on this server; use resume first" };
    }
    try {
      await rec.runtime.abort(rec.session);
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 250));
    try {
      await rec.runtime.destroy(rec.session);
    } catch {}
    return {
      cancelled: true,
      message: "stop signalled; runtime session destroyed; task settles via normal state machine",
    };
  }

  async get(taskId: string): Promise<TaskSession | null> {
    return loadTask(taskId);
  }

  // --- approval relay (9.6.5) ---

  listApprovals(taskId: string): readonly ApprovalRecord[] {
    return this.opts.approvalHub.listPending(taskId);
  }

  async approve(taskId: string, requestId: string, always = false): Promise<{ ok: boolean; message: string }> {
    if (always) {
      // Persist an "always allow" rule for this operation, then still resolve
      // the current approval so the tool proceeds right now.
      const record = this.opts.approvalHub.get(requestId);
      if (record && record.status === "pending") {
        const rule = ruleFromApproval(record.title, record.message);
        if (rule) {
          try {
            await appendRule({ rule });
          } catch {
            // rule persistence failed — still resolve the current approval
          }
        }
      }
    }
    return this.resolveApproval(taskId, requestId, true);
  }

  async deny(taskId: string, requestId: string): Promise<{ ok: boolean; message: string }> {
    return this.resolveApproval(taskId, requestId, false);
  }

  private async resolveApproval(
    taskId: string,
    requestId: string,
    confirmed: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    // Continued-conversation sessions live in `idle` after settle; their
    // approvals must resolve too (mirror `message()`'s lookup).
    const entry = this.idle.get(taskId) ?? this.active.get(taskId);
    if (!entry) return { ok: false, message: "task not active on this server" };
    const record = this.opts.approvalHub.get(requestId);
    if (!record || record.status !== "pending") {
      return { ok: false, message: "no pending approval with that id" };
    }
    if (entry.runtime instanceof PiRuntime) {
      const delivered = await entry.runtime.resolveApproval(requestId, confirmed);
      if (!delivered) return { ok: false, message: "approval channel no longer available" };
      this.opts.approvalHub.mark(requestId, confirmed ? "approved" : "denied");
      return { ok: true, message: confirmed ? "approved" : "denied" };
    }
    return { ok: false, message: "runtime does not support approvals" };
  }

  async list(): Promise<readonly TaskSession[]> {
    return listTasks();
  }

  /**
   * Delete a session: task.json + its event log + undo journal. A running
   * session is refused (cancel first); an idle (settled) session has its Pi
   * process torn down before removal.
   */
  async deleteTask(taskId: string): Promise<{ ok: boolean; message: string }> {
    if (this.active.has(taskId)) {
      return { ok: false, message: "session is running — cancel it first" };
    }
    const idle = this.idle.get(taskId);
    if (idle) {
      try { await idle.runtime.destroy(idle.session); } catch { /* process already gone */ }
      this.idle.delete(taskId);
    }
    await deleteTask(taskId);
    await rm(join(eventsDir(), `${taskId}.events.jsonl`), { force: true });
    await rm(join(this.opts.forgeHome, "undo", taskId), { recursive: true, force: true });
    return { ok: true, message: "deleted" };
  }

  whenSettled(taskId: string): Promise<TaskSession> | null {
    return this.active.get(taskId)?.runPromise ?? null;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  private settle(taskId: string, final: TaskSession): void {
    const entry = this.active.get(taskId);
    if (entry) {
      // Release the workspace lock (other tasks may use the project) but keep
      // the Pi session alive for continued conversation (steering).
      this.releaseLock(entry.workspaceKey, taskId);
      this.active.delete(taskId);
      this.idle.set(taskId, entry);
    }
    this.opts.supervisor.settled(taskId, final.state, final.failureReason);
  }

  /**
   * Continue a session: prompt the SAME Pi session (which retains the full
   * conversation history) with a follow-up message. This is the Codex-style
   * "keep talking to the agent" path — no new plan/state machine, the agent
   * just acts, and its messages/tool calls stream out via onPiEvent.
   */
  async message(taskId: string, message: string): Promise<{ ok: boolean; message: string }> {
    const entry = this.idle.get(taskId) ?? this.active.get(taskId);
    if (!entry) {
      // Phase 9.7: a settled "conversation" session has no Pi runtime — its
      // continued turns are answered by the server-side chat channel.
      const task = await loadTask(taskId);
      if (task?.kind === "conversation") {
        return this.conversationTurn(taskId, message);
      }
      return { ok: false, message: "no active or idle session for this task" };
    }
    const text = message.trim();
    if (!text) return { ok: false, message: "empty message" };
    await appendEvent(taskId, "AGENT_EVENT", { piEvent: { type: "user_message", text } });
    try {
      const turn = await entry.runtime.prompt(entry.session, text, { deadlineMs: 5 * 60_000 });
      if (!turn.success) {
        await appendEvent(taskId, "AGENT_EVENT", { piEvent: { type: "turn_error", error: turn.error } });
        return { ok: false, message: turn.error ?? "turn failed" };
      }
    } catch (err) {
      await appendEvent(taskId, "AGENT_EVENT", { piEvent: { type: "turn_error", error: err instanceof Error ? err.message : String(err) } });
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, message: "ok" };
  }

  /**
   * Mid-session model switch (steering). Resolves the subscription, refreshes
   * models.json so the running Pi session's snapshot includes it, and calls
   * runtime.setModel — conversation history and workspace are preserved.
   */
  async switchModel(taskId: string, providerId: string): Promise<{ ok: boolean; message: string }> {
    const entry = this.idle.get(taskId) ?? this.active.get(taskId);
    if (!entry) return { ok: false, message: "no active or idle session for this task" };
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription = resolveProvider(cfg, providerId);
    if (!subscription) return { ok: false, message: "no such subscription" };
    await syncCustomModels(this.opts.forgeHome, cfg.providers);
    try {
      await entry.runtime.setModel?.(entry.session, {
        provider: providerName(subscription),
        modelId: subscription.modelId,
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    const task = await loadTask(taskId);
    if (task) {
      task.model = { provider: providerName(subscription), modelId: subscription.modelId };
      await saveTask(task);
    }
    await appendEvent(taskId, "AGENT_EVENT", {
      piEvent: { type: "model_switch", provider: subscription.id, modelId: subscription.modelId },
    });
    return { ok: true, message: "ok" };
  }

  /**
   * Continued turn on a "conversation" session. History is replayed from the
   * session event log (single source of truth) and answered by the stateless
   * server chat channel — still no Pi runtime, no task lifecycle.
   */
  private async conversationTurn(taskId: string, message: string): Promise<{ ok: boolean; message: string }> {
    const text = message.trim();
    if (!text) return { ok: false, message: "empty message" };
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const endpoint = endpointFromConfig(cfg);
    // Build history from events that exist BEFORE this turn (no duplication).
    const past = await readEvents(taskId);
    const history: ChatMessage[] = replayConversationHistory(past);
    // Record the user turn (mirrors the engineering message() path); even a
    // failed reply leaves an auditable trace in the session log.
    await appendEvent(taskId, "AGENT_EVENT", { piEvent: { type: "user_message", text } });
    if (!endpoint) {
      return { ok: false, message: "no provider configured for conversation replies" };
    }
    const reply = await conversationReply(endpoint, history, text);
    await appendEvent(taskId, "AGENT_EVENT", {
      piEvent: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: reply },
      },
    });
    return { ok: true, message: "ok" };
  }
}
