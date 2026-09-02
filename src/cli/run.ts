#!/usr/bin/env node
import { EventBus } from "../events/index.ts";
import {
  attachTask,
  newTaskId,
  runOrchestrator,
  startTask,
} from "../orchestrator/index.ts";
import { startUiServer } from "../runtime/ui-server.ts";
import { PiRuntime } from "../runtime/pi/index.ts";
import { TaskRecoveryService } from "../recovery/index.ts";

function parseArgs(argv: readonly string[]): {
  goal: string;
  model: string | undefined;
  resume: string | undefined;
  ui: boolean;
  uiPort: number;
} {
  let goal = "";
  let model: string | undefined;
  let resume: string | undefined;
  let ui = false;
  let uiPort = 5174;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "-m" || a === "--model") {
      const v = argv[i + 1];
      i++;
      if (v) model = v;
    } else if (a === "--resume") {
      const v = argv[i + 1];
      i++;
      if (v) resume = v;
    } else if (a === "--ui") {
      ui = true;
    } else if (a === "--ui-port") {
      const v = argv[i + 1];
      i++;
      if (v) uiPort = Number(v);
    } else if (!a.startsWith("-")) {
      goal = goal ? `${goal} ${a}` : a;
    }
  }
  return { goal: goal.trim(), model, resume, ui, uiPort };
}

function parseModel(s: string | undefined): { provider: string; modelId: string } {
  const fallback = { provider: "anthropic", modelId: "claude-opus-4-8" };
  if (!s) return fallback;
  const i = s.indexOf("/");
  if (i < 0) return fallback;
  return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
}

function pickProviderEnv(provider: string): Record<string, string> | undefined {
  const candidates: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
    openai: ["OPENAI_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    "minimax-cn": ["MINIMAX_CN_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    google: ["GEMINI_API_KEY"],
  };
  const names = candidates[provider];
  if (!names) return undefined;
  for (const n of names) {
    if (process.env[n]) return { [n]: process.env[n]! };
  }
  return undefined;
}

async function main(): Promise<void> {
  const { goal, model, resume, ui, uiPort } = parseArgs(process.argv.slice(2));
  if (!goal && !resume) {
    console.error("usage: forge run <goal> [--model <provider>/<id>] [--resume <taskId>] [--ui] [--ui-port 5174]");
    process.exit(2);
  }

  const bus = new EventBus();
  bus.subscribe((e) => {
    const t = e.at ? new Date(e.at).toISOString() : new Date().toISOString();
    if (e.type === "state_changed") {
      console.log(`[${t}] state: ${e.from} → ${e.to}`);
    } else if (e.type === "step_started") {
      console.log(`[${t}] step_started: ${e.stepId}`);
    } else if (e.type === "step_verified") {
      console.log(`[${t}] step_verified: ${e.stepId}`);
    } else if (e.type === "fix_started") {
      console.log(`[${t}] fix_started: ${e.stepId} (attempt ${e.attempt}) — ${e.reason}`);
    } else if (e.type === "memory_retrieved") {
      if (e.results.length === 0) {
        console.log(`[${t}] memory_retrieved: 0 items`);
      } else {
        console.log(`[${t}] memory_retrieved: ${e.results.length} item(s) for query "${e.query}"`);
        for (const r of e.results) {
          console.log(`    · [${r.item.type}] ${r.item.content}`);
        }
      }
    } else if (e.type === "memory_extracted") {
      console.log(`[${t}] memory_extracted: ${e.items.length} fact(s) stored`);
      for (const it of e.items) {
        console.log(`    · [${it.type}] ${it.content}`);
      }
    } else if (e.type === "completed") {
      console.log(`[${t}] task COMPLETE`);
    } else if (e.type === "failed") {
      console.log(`[${t}] task FAILED: ${e.reason}`);
    } else if (e.type === "pi_event") {
      const payload = e.payload as { type?: string } | undefined;
      if (payload?.type === "message_update") {
        const inner = (payload as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
        if (inner?.type === "text_delta" && inner.delta) {
          process.stdout.write(inner.delta);
        }
      }
    }
  });

  const m = parseModel(model);
  const env = pickProviderEnv(m.provider);
  if (!env) {
    console.error(`forge: no API key env var set for provider '${m.provider}'`);
    console.error(`forge: set one of: ${Object.keys({ ANTHROPIC_API_KEY: 1, OPENAI_API_KEY: 1, MINIMAX_API_KEY: 1, OPENROUTER_API_KEY: 1, GEMINI_API_KEY: 1 }).join(", ")}`);
    process.exit(2);
  }

  const forgeHome = process.env.FORGE_HOME ?? `${process.env.HOME ?? "/tmp"}/.forge`;
  const runtime = new PiRuntime(forgeHome);
  const opts = { runtime, provider: m.provider, modelId: m.modelId, env, eventBus: bus, deadlineMs: undefined, policy: undefined };

  let uiServer: Awaited<ReturnType<typeof startUiServer>> | undefined;
  let handle;
  if (ui && !resume) {
    handle = await startTask({ ...opts, taskId: newTaskId() });
    handle.task.goal = goal;
    uiServer = await startUiServer({ taskId: handle.task.id, bus, port: uiPort, host: "127.0.0.1" });
    console.log(`forge UI: ${uiServer.url} (task=${handle.task.id})`);
  } else if (resume) {
    const recovery = new TaskRecoveryService();
    const decision = await recovery.inspect(resume);
    if (decision.kind === "not_found") {
      console.error(`forge: no task found with id '${resume}'`);
      process.exit(2);
    }
    if (decision.kind === "already_completed") {
      console.log(`forge: task '${resume}' already COMPLETE — nothing to resume`);
      console.log(JSON.stringify({ id: decision.task.id, state: decision.task.state, observations: decision.task.observations.length }, null, 2));
      process.exit(0);
    }
    if (decision.kind === "failed") {
      console.log(`forge: task '${resume}' already FAILED (${decision.reason}) — nothing to resume`);
      process.exit(0);
    }
    const plan = await recovery.plan(resume);
    if (!plan) {
      console.error(`forge: cannot build recovery plan for '${resume}'`);
      process.exit(2);
    }
    console.log(`forge: resuming task '${resume}' from state ${plan.task.state}${plan.runtimeSessionLost ? " (runtime session will be recreated)" : ""}`);
    if (plan.events.length > 0) {
      console.log(`forge: ${plan.events.length} persisted event(s) replayed`);
    }
    handle = await attachTask({ ...opts, taskId: resume });
    if (!handle) {
      console.error(`forge: attach failed for '${resume}'`);
      process.exit(2);
    }
    if (goal && !handle.task.goal) {
      handle.task.goal = goal;
    }
  } else {
    handle = await startTask({ ...opts, taskId: newTaskId() });
    handle.task.goal = goal;
  }

  const final = await runOrchestrator(handle);

  console.log("");
  console.log("==== Final Task ====");
  console.log(`id:     ${final.id}`);
  console.log(`state:  ${final.state}`);
  console.log(`pi:     ${final.piSessionId ?? "(none)"}`);
  console.log(`dir:    ${final.directory}`);
  console.log(`plan:   ${final.plan ? `${final.plan.steps.length} step(s)` : "(none)"}`);
  console.log(`obs:    ${final.observations.length} observation(s)`);
  for (const o of final.observations) {
    console.log(`  - [${o.result}] ${o.stepId} @ ${new Date(o.timestamp).toISOString()}`);
    for (const cr of o.criterionResults) {
      console.log(`    · ${cr.criterion.kind}: ${cr.passed ? "PASS" : "FAIL"} — ${cr.message}`);
    }
  }
  if (final.lastEvaluation) {
    const ev = final.lastEvaluation;
    console.log(`eval:   ${ev.status} (score=${ev.score})`);
    for (const f of ev.findings) {
      console.log(`  · [${f.severity}] ${f.rule}: ${f.message}`);
    }
    for (const e of ev.evidence) {
      console.log(`  evidence ${e.kind}: ${e.detail}`);
    }
  }
  if (final.failureReason) {
    console.log(`reason: ${final.failureReason}`);
  }

  await runtime.destroy(handle.session);
  if (uiServer) await uiServer.close();
  process.exit(final.state === "COMPLETE" ? 0 : 1);
}

main().catch((err) => {
  console.error("forge:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
