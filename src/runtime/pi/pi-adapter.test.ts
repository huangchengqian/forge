import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lastAssistantText } from "./pi-adapter.ts";
import type { PiEvent } from "./pi-rpc-client.ts";

function delta(text: string): PiEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  } as unknown as PiEvent;
}

function messageEnd(role: string, blocks: unknown[]): PiEvent {
  return { type: "message_end", message: { role, content: blocks } } as unknown as PiEvent;
}

describe("lastAssistantText", () => {
  test("accumulates text_delta events when no message_end exists", () => {
    const events = [delta("你好！"), delta("我是 Forge。")];
    assert.equal(lastAssistantText(events), "你好！我是 Forge。");
  });

  test("message_end authoritative text replaces corrupted CJK deltas", () => {
    // Real-world shape (task 4959y): deltas scrambled, final message clean.
    const events = [
      delta("<think>...</think>\n\n你好！我是 to the user. greet"),
      messageEnd("assistant", [
        { type: "text", text: "<think>...</think>\n\n你好！我是 to greet the user." },
      ]),
    ];
    assert.equal(
      lastAssistantText(events),
      "<think>...</think>\n\n你好！我是 to greet the user.",
    );
  });

  test("user message_end events are ignored", () => {
    const events = [
      messageEnd("user", [{ type: "text", text: "You are Forge's planner..." }]),
      delta("规划帮你分析"),
    ];
    assert.equal(lastAssistantText(events), "规划帮你分析");
  });

  test("last non-empty assistant message wins across multiple turns", () => {
    const events = [
      delta('{"understanding":'),
      messageEnd("assistant", [{ type: "text", text: '{"understanding":"第一回合"}' }]),
      // Tool-call-only follow-up turn must not erase the earlier text.
      messageEnd("assistant", [{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: {} }]),
    ];
    assert.equal(lastAssistantText(events), '{"understanding":"第一回合"}');
  });

  test("thinking blocks are excluded from authoritative text", () => {
    const events = [
      delta("残留"),
      messageEnd("assistant", [
        { type: "thinking", thinking: "内部思考" },
        { type: "text", text: "最终回复" },
      ]),
    ];
    assert.equal(lastAssistantText(events), "最终回复");
  });
});
