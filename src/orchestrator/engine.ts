import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { canTransition, isTerminal, type TaskState } from "../core/state/task-state.ts";
import { loadTask, saveTask } from "../core/persistence/task-store.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import type { TaskSession } from "../core/types/task-session.ts";
import type { Plan } from "../core/types/plan.ts";
import type { PlanStep, Observation } from "../core/types/step.ts";
import type { CriterionResult } from "../core/types/criterion.ts";
import { validate } from "../verification/index.ts";
import type { AgentRuntime, RuntimeSession } from "../runtime/interface.ts";
import { extractFromTask, listMemory } from "../memory/index.ts";
import type { Evaluator } from "../evaluation/index.ts";
import { DeterministicEvaluator } from "../evaluation/index.ts";
import { buildStepPrompt } from "./instruction.ts";
import { LlmPlanner } from "./llm-planner.ts";
import type { Planner, TaskContext } from "./planner.ts";
import { applyPlanOps, type PlanOperation } from "./plan-ops.ts";
import { DEFAULT_MAX_CONCURRENCY, ExecutionScheduler } from "./scheduler.ts";
import { runStepBatch } from "./runner.ts";
import { getGlobalSkillRegistry } from "../skills/index.ts";
import type { SkillRegistry } from "../skills/index.ts";
import type { EventBus } from "../events/index.ts";
import { publish } from "../events/index.ts";
import { DEFAULT_RETRY_POLICY, checkFixBudget, type RetryPolicy } from "./retry-policy.ts";
import { decideFix } from "./fix-decision.ts";

const FORGE_HOME = process.env.FORGE_HOME ?? `${process.env.HOME ?? "/tmp"}/.forge`;

export type OrchestratorOptions = {
  runtime: AgentRuntime;
  taskId: string;
  provider: string;
  modelId: string;
  env: Record<string, string> | undefined;
  eventBus: EventBus | undefined;
  deadlineMs: number | undefined;
  policy: RetryPolicy | undefined;
  planner?: Planner;
  skillRegistry?: SkillRegistry;
  maxConcurrency?: number;
  evaluator?: Evaluator;
  /** Exact execution directory. Takes precedence over task.directory and the default fallback. */
  workspace?: string;
};
export type OrchestratorHandle = {
  task: TaskSession;
  session: RuntimeSession;
  runtime: AgentRuntime;
  planner: Planner;
  skillRegistry: SkillRegistry | undefined;
  maxConcurrency: number | undefined;
  evaluator: Evaluator;
  bus: EventBus | undefined;
};

function todayPrefix(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `task_${yyyy}${mm}${dd}`;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 7);
}

export function newTaskId(): string {
  return `${todayPrefix()}_${shortId()}`;
}

async function transition(task: TaskSession, to: TaskState): Promise<TaskSession> {
  if (!canTransition(task.state, to)) {
    throw new Error(`forge: invalid transition ${task.state} → ${to}`);
  }
  const from = task.state;
  const next: TaskSession = { ...task, state: to, updatedAt: Date.now() };
  await saveTask(next);
  await appendEvent(next.id, "STATE_CHANGED", { from, to });
  return next;
}

function emitStateChange(bus: EventBus | undefined, task: TaskSession, from: TaskState, to: TaskState) {
  if (!bus) return;
  publish(bus, { type: "state_changed", taskId: task.id, from, to, at: Date.now() });
}

async function ensureSession(
  task: TaskSession,
  opts: OrchestratorOptions,
): Promise<RuntimeSession> {
  // Workspace precedence: explicit option → persisted workspacePath (v3) →
  // legacy task.directory (v2) → default per-task directory under FORGE_HOME.
  const workspace = opts.workspace?.trim()
    ? resolve(opts.workspace)
    : task.workspacePath?.trim()
      ? resolve(task.workspacePath)
      : task.directory?.trim()
        ? resolve(task.directory)
        : join(FORGE_HOME, "tasks", task.id);
  const session = await opts.runtime.createSession({
    taskId: task.id,
    goal: task.goal,
    workspace,
    model: { provider: opts.provider, modelId: opts.modelId },
    env: opts.env ?? {},
  });
  task.piSessionId = session.id;
  task.runtime = {
    id: session.id,
    directory: session.directory,
    createdAt: Date.now(),
    modelProvider: opts.provider,
    modelId: opts.modelId,
  };
  if (!task.directory) {
    task.directory = session.directory;
  }
  if (!task.workspacePath) {
    task.workspacePath = workspace;
  }
  await saveTask(task);
  return session;
}

function appendObservation(
  task: TaskSession,
  stepId: string,
  attempt: number,
  results: readonly CriterionResult[],
): TaskSession {
  const allPassed = results.every((r) => r.passed);
  const failed = results.filter((r) => !r.passed);
  const failureReason = allPassed
    ? undefined
    : failed.map((r) => `${r.criterion.kind}: ${r.message}`).join("; ");
  const observation: Observation = {
    id: randomUUID(),
    stepId,
    result: allPassed ? "PASS" : "FAIL",
    attempt,
    criterionResults: results,
    failureReason,
    timestamp: Date.now(),
  };
  return {
    ...task,
    observations: [...task.observations, observation],
  };
}

async function runStep(
  task: TaskSession,
  step: PlanStep,
  session: RuntimeSession,
  runtime: AgentRuntime,
  bus: EventBus | undefined,
): Promise<{ task: TaskSession; step: PlanStep }> {
  const prompt = buildStepPrompt(step, task.goal, task.directory);
  publish(bus, { type: "step_started", taskId: task.id, stepId: step.id, at: Date.now() });
  await appendEvent(task.id, "STEP_STARTED", { stepId: step.id, intent: step.intent, attempt: step.attempts + 1 });

  await runtime.prompt(session, prompt, { deadlineMs: 5 * 60_000 });

  const updatedStep: PlanStep = {
    ...step,
    attempts: step.attempts + 1,
    status: "running",
  };

  const plan: Plan | null = task.plan
    ? { ...task.plan, steps: task.plan.steps.map((s) => (s.id === step.id ? updatedStep : s)) }
    : null;

  const partialTask: TaskSession = { ...task, plan, currentStepId: step.id };
  await saveTask(partialTask);

  return { task: partialTask, step: updatedStep };
}

async function observeStep(
  task: TaskSession,
  step: PlanStep,
): Promise<{ task: TaskSession; step: PlanStep; allPassed: boolean }> {
  const results: CriterionResult[] = [];
  for (const c of step.successCriteria) {
    results.push(await validate(c, task.directory));
  }
  const allPassed = results.every((r) => r.passed);
  const updatedStep: PlanStep = {
    ...step,
    status: allPassed ? "verified" : "failed",
  };
  const plan: Plan | null = task.plan
    ? { ...task.plan, steps: task.plan.steps.map((s) => (s.id === step.id ? updatedStep : s)) }
    : null;
  const newTask = appendObservation({ ...task, plan }, step.id, step.attempts, results);
  await saveTask(newTask);
  await appendEvent(newTask.id, "OBSERVATION_CREATED", {
    stepId: step.id,
    result: allPassed ? "PASS" : "FAIL",
    attempt: step.attempts,
    failedCount: results.filter((r) => !r.passed).length,
    totalCount: results.length,
  });
  return { task: newTask, step: updatedStep, allPassed };
}

export async function startTask(opts: OrchestratorOptions): Promise<OrchestratorHandle> {
  const now = Date.now();
  const task: TaskSession = {
    id: opts.taskId,
    goal: "",
    state: "READY",
    plan: null,
    currentStepId: null,
    observations: [],
    runtime: null,
    piSessionId: null,
    directory: "",
    workspacePath: null,
    projectId: null,
    model: { provider: opts.provider, modelId: opts.modelId },
    fixCount: 0,
    createdAt: now,
    updatedAt: now,
    failureReason: null,
    lastEvaluation: null,
  };
  await saveTask(task);
  await appendEvent(task.id, "TASK_CREATED", { goal: "", modelProvider: opts.provider, modelId: opts.modelId });
  if (opts.eventBus) {
    publish(opts.eventBus, { type: "task_started", taskId: task.id, goal: "", at: now });
  }
  const session = await ensureSession(task, opts);
  return {
    task,
    session,
    runtime: opts.runtime,
    planner: opts.planner ?? new LlmPlanner({ runtime: opts.runtime, session }),
    skillRegistry: opts.skillRegistry,
    maxConcurrency: opts.maxConcurrency,
    evaluator: opts.evaluator ?? new DeterministicEvaluator(),
    bus: opts.eventBus,
  };
}

export async function attachTask(opts: OrchestratorOptions): Promise<OrchestratorHandle | null> {
  const task = await loadTask(opts.taskId);
  if (!task) return null;
  if (typeof task.fixCount !== "number") {
    task.fixCount = 0;
  }
  if (typeof task.currentStepId === "undefined") {
    task.currentStepId = null;
  }
  if (typeof task.runtime === "undefined") {
    task.runtime = null;
  }
  if (typeof task.directory !== "string") {
    task.directory = "";
  }
  if (typeof task.workspacePath === "undefined") {
    task.workspacePath = null;
  }
  if (typeof task.projectId === "undefined") {
    task.projectId = null;
  }
  if (typeof task.piSessionId === "undefined") {
    task.piSessionId = null;
  }
  if (typeof task.lastEvaluation === "undefined") {
    task.lastEvaluation = null;
  }
  const session = await ensureSession(task, opts);
  return {
    task,
    session,
    runtime: opts.runtime,
    planner: opts.planner ?? new LlmPlanner({ runtime: opts.runtime, session }),
    skillRegistry: opts.skillRegistry,
    maxConcurrency: opts.maxConcurrency,
    evaluator: opts.evaluator ?? new DeterministicEvaluator(),
    bus: opts.eventBus,
  };
}

export async function runOrchestrator(handle: OrchestratorHandle): Promise<TaskSession> {
  let { task } = handle;
  const { session } = handle;
  const planner = handle.planner;
  const bus = handle.bus;
  const registry = handle.skillRegistry ?? getGlobalSkillRegistry();
  const policy = handle.session ? DEFAULT_RETRY_POLICY : DEFAULT_RETRY_POLICY;
  const optsPolicy = (handle as unknown as { _policy?: RetryPolicy })._policy;
  const finalPolicy: RetryPolicy = optsPolicy ?? DEFAULT_RETRY_POLICY;
  const scheduler = new ExecutionScheduler(handle.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const evaluator = handle.evaluator;

  const deadline = Date.now() + (process.env.FORGE_DEADLINE_MS ? Number(process.env.FORGE_DEADLINE_MS) : 10 * 60_000);

  if (task.state === "READY") {
    const from = task.state;
    task = await transition(task, "UNDERSTAND");
    emitStateChange(bus, task, from, task.state);
    if (task.goal) {
      publish(bus, { type: "task_started", taskId: task.id, goal: task.goal, at: Date.now() });
    }
  }

  while (!isTerminal(task.state) && Date.now() < deadline) {
    switch (task.state) {
      case "UNDERSTAND": {
        const matched = registry.match({
          query: task.goal,
          maxResults: 3,
          minScore: 0.5,
        });
        const ctx: TaskContext = { task, directory: task.directory, matchedSkills: matched };
        const created = await planner.createPlan(ctx);
        const plan = created.plan;
        // Surface which prior memories informed the plan (UI transparency).
        if (created.usedMemories && created.usedMemories.length > 0) {
          await appendEvent(task.id, "MEMORY_USED", {
            memories: created.usedMemories,
          });
        }
        publish(bus, {
          type: "plan_created",
          taskId: task.id,
          plan,
          source: created.source,
          at: Date.now(),
        });
        await appendEvent(task.id, "PLAN_CREATED", {
          version: plan.version,
          stepCount: plan.steps.length,
          source: created.source,
          matchedSkills: matched.map((m) => m.skill.id),
        });
        const updated = { ...task, plan };
        task = await saveAndTransition(updated, "PLAN", bus);
        break;
      }

      case "PLAN": {
        const from = task.state;
        task = await transition(task, "EXECUTE");
        emitStateChange(bus, task, from, task.state);
        break;
      }

      case "EXECUTE": {
        const plan = task.plan;
        if (!plan) {
          task = await failTask(task, "no plan before EXECUTE", bus);
          break;
        }
        const completedIds = new Set(
          plan.steps.filter((s) => s.status === "verified").map((s) => s.id),
        );
        const runningIds = new Set(
          plan.steps.filter((s) => s.status === "running").map((s) => s.id),
        );
        const picked = scheduler.select(plan, completedIds, runningIds);
        if (picked.length === 0 && runningIds.size === 0) {
          const hasPending = plan.steps.some((s) => s.status === "pending");
          if (hasPending) {
            task = await failTask(task, "no executable step but pending remains", bus);
          } else {
            task = await failTask(task, "no executable step in plan", bus);
          }
          break;
        }
        if (picked.length > 0) {
          const { task: afterBatch } = await runStepBatch(
            task,
            picked,
            session,
            handle.runtime,
            bus,
          );
          task = afterBatch;
        }
        const from = task.state;
        task = await transition(task, "OBSERVE");
        emitStateChange(bus, task, from, task.state);
        break;
      }

      case "OBSERVE": {
        const plan = task.plan;
        if (!plan) {
          task = await failTask(task, "no plan during OBSERVE", bus);
          break;
        }
        const justRun = plan.steps.filter((s) => s.status === "running" || s.status === "failed");
        if (justRun.length === 0) {
          task = await failTask(task, "no step to observe", bus);
          break;
        }
        let allPassed = true;
        for (const s of justRun) {
          const r = await observeStep(task, s);
          task = r.task;
          if (r.allPassed) {
            publish(bus, { type: "step_verified", taskId: task.id, stepId: s.id, at: Date.now() });
          } else {
            allPassed = false;
          }
        }
        if (allPassed) {
          const lastObservation = task.observations[task.observations.length - 1];
          const updateResult = lastObservation && task.plan
            ? await planner.updatePlan({ task, directory: task.directory, matchedSkills: [] }, lastObservation)
            : null;
          if (updateResult && updateResult.changed && task.plan && updateResult.plan.id === task.plan.id) {
            const prevSteps = task.plan.steps.map((s) => s.id);
            const nextSteps = updateResult.plan.steps.map((s) => s.id);
            const ops: PlanOperation[] = [];
            for (const s of nextSteps) {
              if (!prevSteps.includes(s)) {
                const added = updateResult.plan.steps.find((x) => x.id === s);
                if (added) ops.push({ op: "add", step: added });
              }
            }
            for (const s of prevSteps) {
              if (!nextSteps.includes(s)) ops.push({ op: "remove", stepId: s });
            }
            task = { ...task, plan: updateResult.plan };
            await saveTask(task);
            publish(bus, {
              type: "plan_revised",
              taskId: task.id,
              plan: updateResult.plan,
              ops,
              at: Date.now(),
            });
            await appendEvent(task.id, "PLAN_REVISED", {
              version: updateResult.plan.version,
              stepCount: updateResult.plan.steps.length,
              opCount: ops.length,
            });
            const from = task.state;
            task = await transition(task, "EXECUTE");
            emitStateChange(bus, task, from, task.state);
            break;
          }
          const remaining = task.plan?.steps.some((s) => s.status !== "verified");
          if (!remaining) {
            const from = task.state;
            task = await transition(task, "EVALUATE");
            emitStateChange(bus, task, from, task.state);
          } else {
            const from = task.state;
            task = await transition(task, "EXECUTE");
            emitStateChange(bus, task, from, task.state);
          }
        } else {
          const fixBudget = checkFixBudget(task.fixCount, finalPolicy);
          if (fixBudget.kind !== "ok") {
            task = await failTask(
              task,
              `${justRun.map((s) => s.id).join(",")} failed: ${fixBudget.kind} (fixes=${task.fixCount})`,
              bus,
            );
            break;
          }
          const from = task.state;
          task = await transition(task, "FIX");
          emitStateChange(bus, task, from, task.state);
        }
        break;
      }

      case "EVALUATE": {
        publish(bus, { type: "evaluation_started", taskId: task.id, at: Date.now() });
        await appendEvent(task.id, "EVALUATION_STARTED", {});
        try {
          const memoryItems = await listMemory();
          const result = await evaluator.evaluate({
            task,
            plan: task.plan,
            observations: task.observations,
            memory: memoryItems,
          });
          task = { ...task, lastEvaluation: result, updatedAt: Date.now() };
          await saveTask(task);
          publish(bus, { type: "evaluation_completed", taskId: task.id, result, at: Date.now() });
          await appendEvent(task.id, "EVALUATION_COMPLETED", {
            score: result.score,
            status: result.status,
            findingCount: result.findings.length,
            rules: result.findings.map((f) => f.rule),
          });

          if (result.status === "REVIEW_REQUIRED") {
            const from = task.state;
            task = await transition(task, "REVIEW_REQUIRED");
            emitStateChange(bus, task, from, task.state);
            const updatedFailed: TaskSession = {
              ...task,
              failureReason: `evaluation: ${result.findings.map((f) => f.message).join("; ")}`,
            };
            await saveTask(updatedFailed);
            task = updatedFailed;
          } else {
            const from = task.state;
            task = await transition(task, "COMPLETE");
            emitStateChange(bus, task, from, task.state);
            const extracted = await extractFromTask(task);
            publish(bus, {
              type: "memory_extracted",
              taskId: task.id,
              items: extracted,
              at: Date.now(),
            });
            publish(bus, { type: "completed", taskId: task.id, at: Date.now() });
            await appendEvent(task.id, "TASK_COMPLETED", { observations: task.observations.length });
          }
        } catch (err) {
          task = await failTask(task, `evaluation error: ${err instanceof Error ? err.message : String(err)}`, bus);
        }
        break;
      }

      case "FIX": {
        const plan = task.plan;
        if (!plan) {
          task = await failTask(task, "no plan during FIX", bus);
          break;
        }
        const lastObs = [...task.observations].reverse().find((o) => o.result === "FAIL");
        if (!lastObs) {
          task = await failTask(task, "FIX without prior FAIL observation", bus);
          break;
        }
        const failedStep = plan.steps.find((s) => s.id === lastObs.stepId);
        if (!failedStep) {
          task = await failTask(task, `FIX target step ${lastObs.stepId} not in plan`, bus);
          break;
        }

        const action = decideFix(failedStep, lastObs, task.directory);
        publish(bus, {
          type: "fix_started",
          taskId: task.id,
          stepId: action.step.id,
          attempt: failedStep.attempts,
          reason: lastObs.failureReason ?? "verification failed",
          at: Date.now(),
        });
        await appendEvent(task.id, "FIX_STARTED", {
          stepId: action.step.id,
          attempt: failedStep.attempts,
          reason: lastObs.failureReason ?? "verification failed",
        });

        const newPlan: Plan = {
          ...plan,
          steps: plan.steps.map((s) => (s.id === action.step.id ? { ...action.step, successCriteria: action.rewrittenCriteria } : s)),
        };
        const updated: TaskSession = {
          ...task,
          plan: newPlan,
          fixCount: task.fixCount + 1,
          updatedAt: Date.now(),
        };
        await saveTask(updated);
        task = updated;

        const rewrittenStep = newPlan.steps.find((s) => s.id === action.step.id);
        if (!rewrittenStep) {
          task = await failTask(task, "FIX lost target step", bus);
          break;
        }
        await handle.runtime.prompt(handle.session, action.promptHint, { deadlineMs: 5 * 60_000 });

        const fixedStep: PlanStep = {
          ...rewrittenStep,
          attempts: rewrittenStep.attempts + 1,
          status: "running",
        };
        const fixedPlan: Plan = {
          ...newPlan,
          steps: newPlan.steps.map((s) => (s.id === fixedStep.id ? fixedStep : s)),
        };
        task = { ...task, plan: fixedPlan };
        await saveTask(task);

        const from = task.state;
        task = await transition(task, "EXECUTE");
        emitStateChange(bus, task, from, task.state);
        break;
      }

      default:
        task = await failTask(task, `unexpected state ${task.state}`, bus);
    }
  }

  if (!isTerminal(task.state) && Date.now() >= deadline) {
    task = await failTask(task, "deadline exceeded", bus);
  }

  void policy;

  return task;
}

async function failTask(task: TaskSession, reason: string, bus: EventBus | undefined): Promise<TaskSession> {
  const from = task.state;
  const updated: TaskSession = { ...task, state: "FAILED", failureReason: reason, updatedAt: Date.now() };
  await saveTask(updated);
  emitStateChange(bus, updated, from, "FAILED");
  if (updated.observations.some((o) => o.result === "FAIL")) {
    const extracted = await extractFromTask(updated);
    publish(bus, {
      type: "memory_extracted",
      taskId: updated.id,
      items: extracted,
      at: Date.now(),
    });
  }
  publish(bus, { type: "failed", taskId: updated.id, reason, at: Date.now() });
  await appendEvent(updated.id, "TASK_FAILED", { reason });
  return updated;
}

async function saveAndTransition(task: TaskSession, to: TaskState, bus: EventBus | undefined): Promise<TaskSession> {
  const from = task.state;
  const updated = await transition(task, to);
  emitStateChange(bus, updated, from, updated.state);
  return updated;
}

