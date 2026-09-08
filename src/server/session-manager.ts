import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { EventBus } from "../events/event-bus.ts";
import { runAgent } from "../agent-runner.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
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
import type { Session, SessionStatus, TrustLevel } from "../types.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

type ActiveEntry = {
  sessionId: string;
  runPromise: Promise<Session>;
  controller: AbortController;
  steeringQueue: AgentMessage[];
  costGuard: import("../guardrails/cost-guard.ts").CostGuard;
};

export class SessionManager {
  private active = new Map<string, ActiveEntry>();
  private idle = new Map<string, ActiveEntry>();

  constructor(
    private readonly opts: {
      bus: EventBus;
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSession(session);
    await appendEvent(sessionId, "SESSION_CREATED", { goal: session.goal, workspace });

    // 4. Guardrails + launch.
    const steeringQueue: AgentMessage[] = [];
    const controller = new AbortController();
    const costGuard = new (await import("../guardrails/cost-guard.ts")).CostGuard(
      input.maxCost ?? null,
    );

    const runPromise = runAgent({
      session,
      model: buildModel(subscription),
      streamFn: makeStreamFnWithKey(subscription.apiKey, providerEnv(subscription)),
      guardrails: {
        sessionId,
        workspace,
        completion: {
          trustLevel,
          criteria: input.criteria ?? [],
          maxCost: input.maxCost ?? null,
          maxTurns: input.maxTurns ?? null,
        },
        approval: this.opts.approvalHub,
        steeringQueue,
        costGuard,
      },
      signal: controller.signal,
      onEvent: () => this.opts.bus.publish({
        type: "session_started",
        sessionId,
        goal: session.goal,
        at: Date.now(),
      }),
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
        throw err;
      });

    void runPromise.catch(() => {});

    this.active.set(sessionId, {
      sessionId,
      runPromise,
      controller,
      steeringQueue,
      costGuard,
    });

    return { sessionId };
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
