import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { PersistedEventType } from "../core/persistence/event-log.ts";

/**
 * Map Pi's AgentEvent stream onto Forge's persisted event types. Events with
 * no persisted counterpart (e.g. duplicate updates) return null and are
 * skipped — the event log only carries what recovery/audit/UI need.
 */
export function mapAgentEventToPersisted(
  event: AgentEvent,
): { type: PersistedEventType; payload: Record<string, unknown> } | null {
  switch (event.type) {
    case "agent_start":
      return { type: "SESSION_STARTED", payload: {} };
    case "agent_end":
      return { type: "SESSION_ENDED", payload: { messages: event.messages.length } };
    case "turn_start":
      return { type: "TURN_STARTED", payload: {} };
    case "turn_end":
      return {
        type: "TURN_ENDED",
        payload: { toolResults: event.toolResults.length },
      };
    case "message_start":
      return { type: "MESSAGE_STARTED", payload: { message: event.message } };
    case "message_update": {
      const ame = event.assistantMessageEvent as { type?: string; delta?: string };
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        return { type: "TEXT_DELTA", payload: { delta: ame.delta } };
      }
      return { type: "MESSAGE_UPDATED", payload: { message: event.message } };
    }
    case "message_end":
      return { type: "MESSAGE_ENDED", payload: { message: event.message } };
    case "tool_execution_start":
      return {
        type: "TOOL_CALL",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
      };
    case "tool_execution_update":
      return {
        type: "TOOL_UPDATE",
        payload: { toolCallId: event.toolCallId, partialResult: event.partialResult },
      };
    case "tool_execution_end":
      return {
        type: "TOOL_RESULT",
        payload: { toolCallId: event.toolCallId, result: event.result, isError: event.isError },
      };
    default:
      return null;
  }
}
