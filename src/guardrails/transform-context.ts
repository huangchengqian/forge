import type { AgentMessage } from "@earendil-works/pi-agent-core";

const MAX_CONTEXT_TOKENS = 100_000; // approximate, character-derived
const CHARS_PER_TOKEN = 4;
const KEEP_RECENT_MESSAGES = 20;

function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string") {
          chars += ((block as { text: string }).text).length;
        }
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Context window management: character-based token estimation with a blunt
 * LastN truncation past the soft window. Pi's built-in compaction
 * (prepareNextTurn) supersedes this in Phase 5.
 */
export function makeTransformContext() {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const tokens = estimateTokens(messages);
    if (tokens <= MAX_CONTEXT_TOKENS) return messages;
    return messages.slice(-KEEP_RECENT_MESSAGES);
  };
}
