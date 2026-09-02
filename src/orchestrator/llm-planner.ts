import { randomUUID } from "node:crypto";
import type { Plan } from "../core/types/plan.ts";
import type { PlanStep, Observation } from "../core/types/step.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";
import type { AgentRuntime, RuntimeSession } from "../runtime/interface.ts";
import { retrieve } from "../memory/index.ts";
import type { Planner, TaskContext, CreatePlanResult, UpdatePlanResult } from "./planner.ts";

export type LlmPlannerOptions = {
  runtime: AgentRuntime;
  session: RuntimeSession;
};

export class LlmPlanner implements Planner {
  constructor(private readonly opts: LlmPlannerOptions) {}

  async createPlan(ctx: TaskContext): Promise<CreatePlanResult> {
    if (ctx.matchedSkills.length > 0) {
      return this.planFromSkills(ctx);
    }
    return this.planFromLlm(ctx);
  }

  async updatePlan(_ctx: TaskContext, _observation: Observation): Promise<UpdatePlanResult> {
    return null;
  }

  private async planFromSkills(ctx: TaskContext): Promise<CreatePlanResult> {
    const { task } = ctx;
    const retrieved = await retrieve({
      query: task.goal,
      types: undefined,
      maxResults: 5,
      minConfidence: 0.5,
    });
    const skill = ctx.matchedSkills[0]!.skill;
    const vars = extractTemplateVars(ctx.task.goal);
    const now = Date.now();
    const steps: PlanStep[] = skill.steps.map((s, i) => ({
      ...s,
      id: s.id.includes("-") ? s.id : `step-${i + 1}`,
      status: "pending",
      attempts: 0,
      dependencies: s.dependencies ?? [],
      executionGroup: s.executionGroup,
      intent: renderTemplate(s.intent, vars),
      successCriteria: s.successCriteria.map((c) => renderCriterion(c, vars)),
    }));
    const plan: Plan = {
      id: randomUUID(),
      version: 1,
      objective: ctx.task.goal,
      steps,
      createdAt: now,
      updatedAt: now,
    };
    return {
      plan,
      source: "skill",
      appliedSkills: ctx.matchedSkills.map((m) => m.skill.id),
      usedMemories: retrieved.map((r) => ({
        id: r.item.id,
        type: r.item.type,
        content: r.item.content.length > 200 ? r.item.content.slice(0, 200) + "…" : r.item.content,
        confidence: r.item.confidence,
      })),
    };
  }

  private async planFromLlm(ctx: TaskContext): Promise<CreatePlanResult> {
    const { task } = ctx;
    const retrieved = await retrieve({
      query: task.goal,
      types: undefined,
      maxResults: 5,
      minConfidence: 0.5,
    });
    let memorySection = "";
    if (retrieved.length > 0) {
      const lines = retrieved.map(
        (r) => `  - [${r.item.type}] (conf=${r.item.confidence}) ${r.item.content}`,
      );
      memorySection = `\nRelevant prior engineering knowledge (use ONLY if applicable):\n${lines.join("\n")}\n`;
    }
    const prompt =
      `You are Forge's planner. Analyze the user's input and produce an execution plan.\n` +
      `User input: ${task.goal}\nWorking directory: ${task.directory}\n${memorySection}\n` +
      `Rules:\n` +
      `- Output ONLY one JSON object. No prose, no code fences, no shell commands.\n` +
      `- Do NOT execute anything; this is planning only.\n` +
      `- Shape: {"understanding":"<one paragraph>","suggestedSteps":[{"intent":"<an engineering outcome to achieve>","successCriteria":[{"kind":"command_exit_zero","command":"<a shell check that verifies the step>"}]}]}\n` +
      `- CRITICAL: if the user's input is NOT an engineering task (a greeting, a question, chit-chat), output suggestedSteps: [] and put your direct conversational reply in "understanding". Do NOT invent a file to create.\n` +
      `- Each step's "intent" describes an outcome, never a shell command. Each step MUST include a concrete successCriteria.`;
    const result = await this.opts.runtime.prompt(this.opts.session, prompt, { deadlineMs: 2 * 60_000 });
    let parsed: { understanding: string; suggestedSteps: Array<{ intent: string; successCriteria: readonly SuccessCriterion[] }> } | null = null;
    if (result.success) {
      parsed = tryExtractJson(result.text);
    }
    if (!parsed || !parsed.suggestedSteps || parsed.suggestedSteps.length === 0) {
      // Three cases land here:
      // 1. Nothing parseable (empty/broken model output).
      // 2. The JSON lost its steps field (field-name corruption).
      // 3. The model judged the input a non-task (greeting/question/chit-chat)
      //    and output suggestedSteps: [] with its reply in "understanding".
      // NEVER synthesize a fake engineering step with a hard-coded file check
      // here — such a check can never pass and the task burns its fix budget
      // in a loop (observed: greeting → fallback checked hello.txt for
      // "wrong-content" → 10 fixes). Reply conversationally instead.
      const understanding = parsed?.understanding?.trim()
        ?? "I could not turn that into an execution plan. Could you clarify or restate what you'd like me to do?";
      parsed = {
        understanding,
        suggestedSteps: [
          {
            intent: `Reply to the user directly, without using any tools: ${understanding}`,
            successCriteria: [{ kind: "command_exit_zero", command: "true" }],
          },
        ],
      };
    }
    const now = Date.now();
    const plan: Plan = {
      id: randomUUID(),
      version: 1,
      objective: task.goal,
      steps: parsed.suggestedSteps.map((s, i) => ({
        id: `step-${i + 1}`,
        intent: s.intent,
        status: "pending",
        attempts: 0,
        successCriteria: s.successCriteria,
        dependencies: [],
        executionGroup: undefined,
      })),
      createdAt: now,
      updatedAt: now,
    };
    return {
      plan,
      source: parsed.understanding.startsWith("fallback") ? "fallback" : "llm",
      appliedSkills: [],
      usedMemories: retrieved.map((r) => ({
        id: r.item.id,
        type: r.item.type,
        content: r.item.content.length > 200 ? r.item.content.slice(0, 200) + "…" : r.item.content,
        confidence: r.item.confidence,
      })),
    };
  }
}

export function extractTemplateVars(goal: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pathMatch = goal.match(/(?:create|write|fix|modify|add)\s+([\w./-]+\.[a-z0-9]+)\b/i);
  if (pathMatch && pathMatch[1]) out.path = pathMatch[1];
  const anyTsMatch = goal.match(/\b([\w-]+\.ts)\b/);
  if (!out.path && anyTsMatch && anyTsMatch[1]) out.path = anyTsMatch[1];
  if (!out.path) {
    out.path = /\b(typescript|\.ts\b|tsc|typecheck|utility function)\b/i.test(goal)
      ? "util.ts"
      : "output.txt";
  }
  if (/\b(typescript|\.ts\b|tsc|typecheck|function|utility)\b/i.test(goal)) {
    out.pattern = "export ";
  } else {
    out.pattern = "ok";
  }
  return out;
}

function renderTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function renderCriterion(c: SuccessCriterion, vars: Record<string, string>): SuccessCriterion {
  switch (c.kind) {
    case "file_exists":
      return { ...c, path: renderTemplate(c.path, vars) };
    case "file_contains":
      return { ...c, path: renderTemplate(c.path, vars), pattern: renderTemplate(c.pattern, vars) };
    case "file_not_contains":
      return { ...c, path: renderTemplate(c.path, vars), pattern: renderTemplate(c.pattern, vars) };
    case "command_exit_zero":
      return c.cwd !== undefined
        ? { ...c, command: renderTemplate(c.command, vars), cwd: c.cwd }
        : { ...c, command: renderTemplate(c.command, vars) };
    case "test_pass":
      return { ...c, name: renderTemplate(c.name, vars) };
    case "git_diff_contains":
      return { ...c, pattern: renderTemplate(c.pattern, vars) };
    case "directory_exists":
      return { ...c, path: renderTemplate(c.path, vars) };
  }
}

/**
 * When the model omits successCriteria, infer a reasonable check from the step
 * intent (file creation steps → file_exists) instead of a vacuous `true`.
 */
function inferCriteriaFromIntent(intent: string): SuccessCriterion[] {
  const m = intent.match(/\b([\w./-]+\.(?:ts|tsx|js|jsx|json|txt|md|py|go|rs|css|html))\b/i);
  if (m?.[1]) return [{ kind: "file_exists", path: m[1] }];
  return [{ kind: "command_exit_zero", command: "true" }];
}

/**
 * Locate a JSON key whose non-ASCII-normalized form matches a target name.
 * Pi's stream can interleave CJK text into field names (observed:
 * "suggestedSteps" arriving as "suggest分步执行edSteps"), which breaks exact
 * key access. Stripping non-ASCII letters recovers the intended key in most
 * corruption patterns.
 */
function findFuzzyKey(obj: Record<string, unknown>, ...targets: string[]): string | null {
  for (const key of Object.keys(obj)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const t of targets) {
      if (norm === t || norm.includes(t)) return key;
    }
  }
  return null;
}

export function tryExtractJson(text: string): { understanding: string; suggestedSteps: Array<{ intent: string; successCriteria: readonly SuccessCriterion[] }> } | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = fence && fence[1] ? fence[1] : text;
  // Reasoning models emit a <think>...</think> prefix inside the content
  // stream (Pi does not strip it yet). Remove it, then fall back to the
  // outermost {...} block so a trailing explanation is ignored too.
  candidate = candidate.replace(/<\s*think\s*>[\s\S]*?<\/\s*think\s*>/g, " ");
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (!fence && start >= 0 && end > start) candidate = candidate.slice(start, end + 1);
  try {
    const obj = JSON.parse(candidate.trim()) as Record<string, unknown>;
    const stepsKey = findFuzzyKey(obj, "suggestedsteps", "steps");
    if (obj && stepsKey && Array.isArray(obj[stepsKey])) {
      const steps = obj[stepsKey]
        .filter((s: unknown): s is { intent: string; successCriteria?: readonly SuccessCriterion[] } => {
          return !!s && typeof (s as { intent?: unknown }).intent === "string";
        })
        .map((s: { intent: string; successCriteria?: readonly SuccessCriterion[] }) => ({
          intent: s.intent,
          successCriteria: Array.isArray(s.successCriteria) && s.successCriteria.length > 0
            ? s.successCriteria
            : inferCriteriaFromIntent(s.intent),
        }));
      const understandingKey = findFuzzyKey(obj, "understanding");
      return {
        understanding: understandingKey && typeof obj[understandingKey] === "string" ? obj[understandingKey] : "",
        suggestedSteps: steps,
      };
    }
  } catch {}
  return null;
}
