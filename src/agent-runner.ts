import {
  agentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./core/persistence/event-log.ts";
import { mapAgentEventToPersisted } from "./events/mapper.ts";
import { makeBeforeToolCall } from "./guardrails/before-tool-call.ts";
import { makeAfterToolCall } from "./guardrails/after-tool-call.ts";
import { makeTransformContext } from "./guardrails/transform-context.ts";
import { makePrepareNextTurn } from "./guardrails/compaction.ts";
import { makeShouldStopAfterTurn } from "./guardrails/should-stop-after-turn.ts";
import type { GuardrailConfig } from "./guardrails/types.ts";
import type { Session } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (m) =>
      m.role === "user" || m.role === "assistant" || (m as { role?: string }).role === "toolResult",
  );
}

function buildSystemPrompt(session: Session): string {
  return [
    "You are Forge's engineering agent working in the user's project.",
    `Working directory: ${session.workspace}`,
    "",
    "Use tools to read, write, edit files and run commands.",
    "When the goal is fully met, stop calling tools.",
  ].join("\n");
}

/**
 * Run Pi's agentLoop in-process with Forge guardrails injected as hooks.
 * Every event is consumed: mapped into the FIFO event log (persistence +
 * SSE source of truth), optionally streamed to the caller, and usage is fed
 * into the cost guard.
 */
export async function runAgent(opts: {
  session: Session;
  model: Model<any>;
  guardrails?: GuardrailConfig;
  signal?: AbortSignal;
  /** LLM streaming function: Pi's streamSimple wrapped with the subscription key,
   *  or a scripted mock in smoke tests. */
  streamFn: Parameters<typeof agentLoop>[4];
  onEvent?: (event: AgentEvent) => void;
}): Promise<Session> {
  const { session, model, guardrails, signal, streamFn, onEvent } = opts;

  const tools = createCodingTools(session.workspace) ?? [];
  const context: AgentContext = {
    systemPrompt: buildSystemPrompt(session),
    messages: session.messages,
    tools,
  };

  const config: AgentLoopConfig = {
    model,
    convertToLlm: defaultConvertToLlm as AgentLoopConfig["convertToLlm"],
    transformContext: makeTransformContext(),
  };

  if (guardrails) {
    config.beforeToolCall = makeBeforeToolCall(guardrails);
    config.afterToolCall = makeAfterToolCall(guardrails);
    config.shouldStopAfterTurn = makeShouldStopAfterTurn(guardrails);
    config.getSteeringMessages = async () => guardrails.steeringQueue.splice(0);
    // prepareNextTurn uses the real per-turn inputTokens (provider-reported)
    // rather than the character estimate in transformContext. transformContext
    // remains as a coarse last-resort guard for sessions without cost data.
    config.prepareNextTurn = makePrepareNextTurn({
      sessionId: session.id,
      costGuard: guardrails.costGuard,
      emitEvent: (type, payload) => appendEvent(session.id, type as Parameters<typeof appendEvent>[1], payload),
    });
  }

  const prompts: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: session.goal }], timestamp: Date.now() },
  ];

  const stream = agentLoop(prompts, context, config, signal, streamFn);

  for await (const event of stream) {
    onEvent?.(event);
    const mapped = mapAgentEventToPersisted(event);
    if (mapped) {
      await appendEvent(session.id, mapped.type, mapped.payload);
    }
    // Cost tracking from assistant usage (authoritative per-message totals).
    if (event.type === "message_end" && guardrails) {
      const message = event.message as { role?: string; usage?: unknown };
      if (message.role === "assistant" && message.usage) {
        guardrails.costGuard.trackUsage(
          message.usage as Parameters<typeof guardrails.costGuard.trackUsage>[0],
        );
        await appendEvent(session.id, "COST_UPDATE", {
          spent: guardrails.costGuard.getSpent(),
          budget: guardrails.costGuard.getRemaining(),
        });
      }
    }
  }

  // Pi's `agentLoop` returns `result()` as the *delta* (newMessages) — only
  // the prompt(s) we passed in plus any assistant/tool messages it produced
  // during this run. The initial `context.messages` (which on resume is the
  // replayed transcript) is NOT included. We concatenate to preserve the
  // full conversation.
  const newMessages = await stream.result();
  session.messages = [...session.messages, ...newMessages];
  return session;
}
