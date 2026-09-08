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
 * Phase 1 entry point: assemble Pi's AgentLoopConfig and run the loop,
 * persisting every event into the FIFO event log. Guardrail hooks
 * (beforeToolCall / afterToolCall / shouldStopAfterTurn / transformContext)
 * are Phase 2-3 additions — this skeleton only wires convertToLlm.
 */
export async function runAgent(opts: {
  session: Session;
  model: Model<any>;
  signal?: AbortSignal;
  /** LLM streaming function. Required — Pi has no implicit default. */
  streamFn: Parameters<typeof agentLoop>[4];
  onEvent?: (event: AgentEvent) => void;
}): Promise<Session> {
  const { session, model, signal, streamFn, onEvent } = opts;

  const tools = createCodingTools(session.workspace) ?? [];
  const context: AgentContext = {
    systemPrompt: buildSystemPrompt(session),
    messages: session.messages,
    tools,
  };

  const config: AgentLoopConfig = {
    model,
    convertToLlm: defaultConvertToLlm as AgentLoopConfig["convertToLlm"],
  };

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
  }

  session.messages = await stream.result();
  return session;
}
