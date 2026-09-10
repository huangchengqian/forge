import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { runAgent } from "../agent-runner.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import { replaySession } from "../core/persistence/replay.ts";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession as removeSession,
} from "../core/persistence/session-store.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { buildModel, makeStreamFnWithKey, providerEnv } from "./model-resolver.ts";
import { loadForgeConfig, resolveProvider } from "./config-store.ts";
import type { ProviderConfig } from "./config-store.ts";
import type { Session, SessionStatus, TrustLevel, CompletionConfig } from "../types.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

type ActiveEntry = {
  sessionId: string;
  runPromise: Promise<Session>;
  controller: AbortController;
  steeringQueue: AgentMessage[];
  costGuard: import("../guardrails/cost-guard.ts").CostGuard;
};

/**
 * Sessions in these terminal states can be resumed. `running` is forbidden
 * (would double-write the event log).
 *
 * `completed` follow-ups (2026-09-09, PM via real-use acceptance): a
 * finished session must accept a follow-up message and continue the loop —
 * chat-style continuation. `failed`/`cancelled` retry the goal.
 */
const RESUMABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "failed",
  "cancelled",
  "completed",
]);

export class SessionManager {
  private active = new Map<string, ActiveEntry>();
  private idle = new Map<string, ActiveEntry>();
  /**
   * Mid-session model switches, keyed by sessionId. `switchModel()` parks a
   * pre-built Model here; the prepareNextTurn hook picks it up at the next
   * turn boundary and hands it to Pi's loop (AgentLoopTurnUpdate.model).
   * Consumed at most once per switch.
   */
  private pendingModels = new Map<string, Model<any>>();
  /**
   * Live completion config per running session — the *same object* handed to
   * the guardrails in `launchAgent`. `makeShouldStopAfterTurn` re-reads
   * `config.completion` at every turn boundary, so mutating `trustLevel` here
   * takes effect on the next turn without a new hook or a relaunch.
   */
  private completions = new Map<string, CompletionConfig>();

  constructor(
    private readonly opts: {
      forgeHome: string;
      projects: ProjectsRegistry;
      approvalHub: ApprovalHub;
    },
  ) {}

  async create(input: {
    goal: string;
    projectId?: string | undefined;
    providerId?: string | undefined;
    trustLevel?: TrustLevel | undefined;
    criteria?: SuccessCriterion[] | undefined;
    maxCost?: number | undefined;
    maxTurns?: number | undefined;
    kind?: "conversation" | "task" | undefined;
  }): Promise<{ sessionId: string }> {
    // 1. Resolve the subscription (explicit providerId or the default one).
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription: ProviderConfig | null = resolveProvider(cfg, input.providerId);
    if (!subscription) {
      throw new Error(
        "no model subscription configured — add one in Settings or ~/.forge/forge-config.json",
      );
    }

    // 2. Resolve workspace from the project registry.
    const registry = await this.opts.projects.list();
    const project = input.projectId
      ? registry.projects.find((p) => p.id === input.projectId)
      : registry.projects.find((p) => p.id === registry.activeProjectId);
    const workspace = project?.path ?? this.opts.forgeHome;

    // 3. Session record.
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const trustLevel: TrustLevel = input.trustLevel ?? "low";
    const session: Session = {
      id: sessionId,
      kind: input.kind ?? "task",
      goal: input.goal,
      workspace,
      projectId: project?.id ?? null,
      model: { provider: subscription.id, modelId: subscription.modelId },
      messages: [],
      status: "running",
      failureReason: null,
      cost: { total: 0, budget: input.maxCost ?? null },
      trustLevel,
      completionCriteria: input.criteria ?? [],
      lastEvaluation: null,
      maxTurns: input.maxTurns ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSession(session);
    await appendEvent(sessionId, "SESSION_CREATED", { goal: session.goal, workspace });

    // 4. Guardrails + launch.
    const costGuard = new (await import("../guardrails/cost-guard.ts")).CostGuard(
      input.maxCost ?? null,
    );
    const { controller, steeringQueue, runPromise } = await this.launchAgent(
      session,
      subscription,
      costGuard,
      {
        trustLevel,
        criteria: input.criteria ?? [],
        maxCost: input.maxCost ?? null,
        maxTurns: input.maxTurns ?? null,
      },
    );

    this.active.set(sessionId, {
      sessionId,
      runPromise,
      controller,
      steeringQueue,
      costGuard,
    });

    return { sessionId };
  }

  /**
   * Resume a failed or cancelled session from its event log. Replays the
   * last coherent AgentMessage[] (drops any unterminated message_started
   * pair), restores the CostGuard's spent counter from persisted
   * `session.cost.total`, and re-launches the agent loop on the recovered
   * session.
   *
   * If `opts.message` is provided, it is appended to `session.messages` as a
   * user turn AND pushed onto the steering queue — Pi's agentLoop consumes
   * new messages from the messages array at the next turn boundary.
   *
   * Failure modes (caller maps to HTTP codes):
   *   - session not found        → throw "session {id} not found"
   *   - status not in whitelist  → throw "session {id} cannot be resumed (status=...)"
   *   - session already active   → throw "session {id} is already running"
   *   - subscription missing     → throw (same error as create())
   */
  async resume(
    sessionId: string,
    opts?: { message?: string | undefined },
  ): Promise<{ sessionId: string }> {
    // 1. Load session.
    const session = await loadSession(sessionId);
    if (!session) {
      throw new Error(`session ${sessionId} not found`);
    }

    // 2. Status whitelist. Remember the prior state: a `completed` resume is
    // a chat-style follow-up (prompt = the new message); `failed`/`cancelled`
    // is a retry (prompt = the goal).
    const priorStatus = session.status;
    if (!RESUMABLE_STATUSES.has(session.status)) {
      throw new Error(
        `session ${sessionId} cannot be resumed (status=${session.status}; only failed/cancelled/completed are resumable)`,
      );
    }

    // 3. Not already active.
    if (this.active.has(sessionId)) {
      throw new Error(`session ${sessionId} is already running — cannot resume concurrently`);
    }

    // 4. Replay messages from event log.
    const { messages } = await replaySession(sessionId);
    session.messages = messages;

    // 5. Optional steering message: append as a user turn AND queue it for
    //    the next loop iteration. We do both so that:
    //    - if the loop reads from messages directly, the new turn is there;
    //    - if the loop drains the steering queue first, it's still there.
    //    Idempotency: appendEvent once, push steeringQueue once.
    if (opts?.message) {
      const userTurn: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: opts.message }],
        timestamp: Date.now(),
      } as AgentMessage;
      session.messages.push(userTurn);
      // steeringQueue is created fresh by launchAgent; we'll push after.
    }

    // 6. Update session state to running and persist.
    session.status = "running";
    session.failureReason = null;
    session.updatedAt = Date.now();
    await saveSession(session);

    // 7. Surface a resume marker so the UI can show "resumed from N messages,
    // optional steering". Per-message STARTED-without-ENDED entries are
    // dropped silently by `replaySession` — there's no repair event
    // because there's nothing for the UI to act on (the half-written
    // message is simply absent from the recovered transcript).
    await appendEvent(sessionId, "SESSION_RESUMED", {
      messagesRecovered: messages.length,
      hasSteeringMessage: !!opts?.message,
    }).catch(() => {});

    // 8. CostGuard hydrates from persisted cost.
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription: ProviderConfig | null = resolveProvider(cfg, session.model.provider);
    if (!subscription) {
      throw new Error(
        `no model subscription for provider "${session.model.provider}" — re-add it in Settings`,
      );
    }
    const costGuard = new (await import("../guardrails/cost-guard.ts")).CostGuard(
      session.cost.budget,
    );
    costGuard.hydrate(session.cost.total);

    // 9. Launch (re-uses helper). Semantics by prior state:
    //   - failed/cancelled → retry: prompt = goal, message rides the
    //     steering queue as corrective guidance.
    //   - completed → follow-up: prompt = the message itself (the goal is
    //     already in the replayed history; re-sending it would re-run the
    //     finished task).
    const wasCompleted = priorStatus === "completed";
    const launchOpts = {
      trustLevel: session.trustLevel,
      criteria: session.completionCriteria,
      // Turn budget is persisted since schema v5 and survives resume.
      maxCost: session.cost.budget,
      maxTurns: session.maxTurns,
    };
    const { controller, steeringQueue, runPromise } = await this.launchAgent(
      session,
      subscription,
      costGuard,
      launchOpts,
      wasCompleted ? opts?.message : undefined,
    );

    // 10. Push steering message now that steeringQueue exists (retry path
    // only — completed follow-ups ride as the prompt, see above).
    if (opts?.message && !wasCompleted) {
      steeringQueue.push({
        role: "user",
        content: [{ type: "text", text: opts.message }],
        timestamp: Date.now(),
      } as AgentMessage);
    }

    this.active.set(sessionId, {
      sessionId,
      runPromise,
      controller,
      steeringQueue,
      costGuard,
    });

    return { sessionId };
  }

  /**
   * Mid-session model switch. Running sessions: the new model takes effect
   * at the next turn boundary (the prepareNextTurn hook consumes it from
   * pendingModels and returns it as AgentLoopTurnUpdate.model). Idle
   * sessions: persisted on the Session, effective on the next resume.
   */
  async switchModel(
    sessionId: string,
    providerId: string,
  ): Promise<{ modelId: string }> {
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription = resolveProvider(cfg, providerId);
    if (!subscription) {
      throw new Error(`no model subscription for provider "${providerId}"`);
    }

    if (this.active.has(sessionId)) {
      this.pendingModels.set(sessionId, buildModel(subscription));
    } else {
      const session = await loadSession(sessionId);
      if (!session) throw new Error(`session ${sessionId} not found`);
      session.model = { provider: subscription.id, modelId: subscription.modelId };
      await saveSession(session);
    }

    await appendEvent(sessionId, "MODEL_CHANGED", {
      providerId: subscription.id,
      modelId: subscription.modelId,
    }).catch(() => {});
    return { modelId: subscription.modelId };
  }

  /**
   * Mid-session completion-verification switch. `trustLevel` decides how hard
   * "the model says it is done" is checked: low accepts the stop (chat /
   * questions), medium runs the criteria or, failing those, the project's
   * `npm test`, high adds the deterministic evaluator on top.
   *
   * A running session picks this up at the next turn boundary: the guardrail
   * destructures `config.completion` on every turn, so mutating the live
   * object is enough — no queue, no relaunch. An idle session just persists it
   * for the next resume.
   */
  async switchTrust(
    sessionId: string,
    trustLevel: TrustLevel,
  ): Promise<{ trustLevel: TrustLevel }> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);

    session.trustLevel = trustLevel;
    session.updatedAt = Date.now();
    await saveSession(session);

    const live = this.completions.get(sessionId);
    if (live) live.trustLevel = trustLevel;

    await appendEvent(sessionId, "TRUST_CHANGED", { trustLevel }).catch(() => {});
    return { trustLevel };
  }

  /**
   * Launch the agent loop on a (possibly recovered) session. Shared by
   * `create()` and `resume()`. The caller owns the CostGuard's lifetime and
   * is responsible for adding the returned entry to `this.active`.
   *
   * `promptOverride`: when a completed session is continued with a
   * follow-up message, that message — not the original goal — is the new
   * turn's prompt (the goal already lives in the replayed history; re-sending
   * it would make the model re-run the finished task).
   */
  private async launchAgent(
    session: Session,
    subscription: ProviderConfig,
    costGuard: import("../guardrails/cost-guard.ts").CostGuard,
    completion: CompletionConfig,
    promptOverride?: string | undefined,
  ): Promise<{
    controller: AbortController;
    steeringQueue: AgentMessage[];
    runPromise: Promise<Session>;
  }> {
    const steeringQueue: AgentMessage[] = [];
    const controller = new AbortController();
    const sessionId = session.id;
    // Keep the live object reachable so switchTrust() can mutate it mid-run.
    this.completions.set(sessionId, completion);

    const runPromise = runAgent({
      session,
      model: buildModel(subscription),
      streamFn: makeStreamFnWithKey(subscription.apiKey, providerEnv(subscription)),
      guardrails: {
        sessionId,
        workspace: session.workspace,
        session,
        completion,
        approval: this.opts.approvalHub,
        steeringQueue,
        costGuard,
      },
      signal: controller.signal,
      promptOverride,
      takeModelSwitch: () => {
        const pending = this.pendingModels.get(sessionId);
        if (pending) this.pendingModels.delete(sessionId);
        return pending ?? null;
      },
    })
      .then((final) => {
        this.settle(sessionId, final, costGuard);
        return final;
      })
      .catch(async (err) => {
        session.status = "failed";
        session.failureReason = err instanceof Error ? err.message : String(err);
        session.updatedAt = Date.now();
        await saveSession(session);
        await appendEvent(sessionId, "SESSION_FAILED", {
          reason: session.failureReason,
        }).catch(() => {});
        this.active.delete(sessionId);
        this.completions.delete(sessionId);
        throw err;
      });

    void runPromise.catch(() => {});
    return { controller, steeringQueue, runPromise };
  }

  async steer(sessionId: string, message: string): Promise<{ ok: boolean; message: string }> {
    const entry = this.active.get(sessionId);
    if (!entry) return { ok: false, message: "session is not running" };
    entry.steeringQueue.push({
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    } as AgentMessage);
    await appendEvent(sessionId, "STEERING_QUEUED", { message }).catch(() => {});
    return { ok: true, message: "queued" };
  }

  async abort(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const entry = this.active.get(sessionId);
    if (!entry) return { ok: false, message: "session is not running" };
    entry.controller.abort();
    return { ok: true, message: "aborting" };
  }

  async get(sessionId: string): Promise<Session | null> {
    return loadSession(sessionId);
  }

  async list(): Promise<Session[]> {
    return listSessions();
  }

  async delete(sessionId: string): Promise<{ ok: boolean; message: string }> {
    if (this.active.has(sessionId)) {
      return { ok: false, message: "session is running — abort it first" };
    }
    await removeSession(sessionId);
    // Event log and undo journal are retained deliberately: audit trail.
    return { ok: true, message: "deleted" };
  }

  listApprovals(sessionId: string) {
    return this.opts.approvalHub.listPending(sessionId);
  }

  async approve(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: this.opts.approvalHub.mark(requestId, "approved") };
  }

  async deny(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: this.opts.approvalHub.mark(requestId, "denied") };
  }

  private settle(sessionId: string, final: Session, costGuard: ActiveEntry["costGuard"]): void {
    const entry = this.active.get(sessionId);
    if (entry) {
      this.active.delete(sessionId);
      this.idle.set(sessionId, entry);
    }
    // The loop is gone; drop the live reference so switchTrust() cannot mutate
    // a config nobody reads. A resume re-registers a fresh one.
    this.completions.delete(sessionId);
    const status: SessionStatus = final.failureReason ? "failed" : "completed";
    final.status = status;
    final.cost = { ...final.cost, total: costGuard.getSpent() };
    final.updatedAt = Date.now();
    void saveSession(final);
    void appendEvent(sessionId, status === "failed" ? "SESSION_FAILED" : "SESSION_ENDED", {
      status,
      cost: final.cost.total,
    }).catch(() => {});
  }
}
