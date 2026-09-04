import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIntent,
  conversationReply,
  extractIntentJson,
  replayConversationHistory,
  ruleCheck,
} from "./intent-router.ts";
import type { ProviderEndpoint } from "./provider-api.ts";

const EP: ProviderEndpoint = {
  apiKey: "k",
  modelId: "m",
  baseUrl: "https://example.com/v1",
  api: "openai-completions",
};

describe("extractIntentJson", () => {
  test("plain task JSON", () => {
    assert.deepEqual(extractIntentJson('{"kind":"task"}'), { kind: "task", reply: undefined });
  });

  test("conversation JSON with reply", () => {
    const r = extractIntentJson('{"kind":"conversation","reply":"你好！"}');
    assert.equal(r?.kind, "conversation");
    assert.equal(r?.reply, "你好！");
  });

  test("<think> prefix is stripped (reasoning models)", () => {
    const r = extractIntentJson(
      "<think>This is clearly a greeting.</think>\n\n{\"kind\":\"conversation\",\"reply\":\"hi\"}",
    );
    assert.equal(r?.kind, "conversation");
  });

  test("fenced JSON", () => {
    const r = extractIntentJson('```json\n{"kind":"task"}\n```');
    assert.equal(r?.kind, "task");
  });

  test("trailing prose after the object is ignored", () => {
    const r = extractIntentJson('{"kind":"conversation","reply":"ok"} Hope that helps!');
    assert.equal(r?.kind, "conversation");
  });

  test("garbage returns null", () => {
    assert.equal(extractIntentJson("sorry I cannot help with that"), null);
    assert.equal(extractIntentJson(""), null);
  });

  test("truncated conversation JSON recovers kind + partial reply", () => {
    const r = extractIntentJson(
      '<think>This is chat.</think>\n\n{"kind":"conversation","reply":"递归就是函数调用自己，用来解决",',
    );
    assert.equal(r?.kind, "conversation");
    assert.equal(r?.reply, "递归就是函数调用自己，用来解决");
  });

  test("truncated task JSON still routes to task", () => {
    const r = extractIntentJson('{"kind":"task","int');
    assert.deepEqual(r, { kind: "task" });
  });
});

describe("ruleCheck (task fast-path)", () => {
  test("bare imperative with object → task", () => {
    assert.deepEqual(ruleCheck("修复这个 bug"), { kind: "task" });
    assert.deepEqual(ruleCheck("帮我修复一个 bug"), { kind: "task" });
    assert.deepEqual(ruleCheck("创建 util.ts 并写个测试"), { kind: "task" });
    assert.deepEqual(ruleCheck("删除文件"), { kind: "task" });
    assert.deepEqual(ruleCheck("跑一下测试"), { kind: "task" });
    assert.deepEqual(ruleCheck("帮我看看这个 bug 是什么原因，然后修掉"), { kind: "task" });
  });

  test("educational questions stay with the model", () => {
    assert.equal(ruleCheck("修复 bug 一般是什么原因？"), null);
    assert.equal(ruleCheck("重构的好处"), null);
    assert.equal(ruleCheck("解释一下什么是递归"), null);
    assert.equal(ruleCheck("你好"), null);
    assert.equal(ruleCheck("帮我总结一下刚才的内容"), null);
  });
});

describe("classifyIntent", () => {
  function fake(text: string) {
    return {
      chat: async () => text,
    };
  }

  test("task JSON → task", async () => {
    const r = await classifyIntent(EP, "create a file", fake('{"kind":"task"}'));
    assert.deepEqual(r, { kind: "task" });
  });

  test("conversation JSON with reply → reply surfaced", async () => {
    const r = await classifyIntent(EP, "你好", fake('{"kind":"conversation","reply":"你好！有什么可以帮你？"}'));
    assert.deepEqual(r, { kind: "conversation", reply: "你好！有什么可以帮你？" });
  });

  test("model error → conservative task (do not swallow an engineering request)", async () => {
    const r = await classifyIntent(EP, "fix this bug", {
      chat: async () => {
        throw new Error("network down");
      },
    });
    assert.deepEqual(r, { kind: "task" });
  });

  test("unparseable output → conservative task", async () => {
    const r = await classifyIntent(EP, "what is SHACL?", fake("I'd love to help with that!"));
    assert.deepEqual(r, { kind: "task" });
  });
});

describe("replayConversationHistory", () => {
  test("user/assistant turns survive with think blocks stripped", () => {
    const events = [
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<think>hmm</think>你好！我是" } } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " Forge。" } } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "user_message", text: "你好" } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "有什么可以帮你？" } } } },
    ];
    const out = replayConversationHistory(events);
    assert.deepEqual(out, [
      { role: "assistant", content: "你好！我是 Forge。" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "有什么可以帮你？" },
    ]);
  });

  test("trim to maxTurns user turns", () => {
    const events: Array<{ type: string; payload: { piEvent: { type: string; text?: string; assistantMessageEvent?: { type: string; delta: string } } } }> = [];
    for (let i = 1; i <= 10; i++) {
      events.push({ type: "AGENT_EVENT", payload: { piEvent: { type: "user_message", text: `q${i}` } } });
      events.push({
        type: "AGENT_EVENT",
        payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `a${i}` } } },
      });
    }
    const out = replayConversationHistory(events, 3);
    assert.equal(out.length, 6);
    assert.equal(out[0]!.role, "user");
    assert.equal(out[0]!.content, "q8");
    assert.equal(out[5]!.content, "a10");
  });

  test("non-agent events ignored", () => {
    const events = [
      { type: "TASK_CREATED", payload: { goal: "你好" } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } } } },
    ];
    assert.deepEqual(replayConversationHistory(events), [{ role: "assistant", content: "hi" }]);
  });

  test("message_end authoritative text replaces corrupted CJK deltas", () => {
    // Real-world shape (task 4959y): deltas arrive with character reordering
    // ("to the user. greet") while the final message is clean.
    const events = [
      { type: "AGENT_EVENT", payload: { piEvent: { type: "user_message", text: "你好" } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好！我是 to the user. greet" } } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好！我是 to greet the user." }] } } } },
    ];
    const out = replayConversationHistory(events);
    assert.deepEqual(out, [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！我是 to greet the user." },
    ]);
  });

  test("message_end for user messages and empty text is ignored", () => {
    const events = [
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "干净回复" } } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt echo" }] } } } },
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: {} }] } } } },
    ];
    const out = replayConversationHistory(events);
    assert.deepEqual(out, [{ role: "assistant", content: "干净回复" }]);
  });

  test("deltas still used when no message_end arrives", () => {
    const events = [
      { type: "AGENT_EVENT", payload: { piEvent: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "仅 delta" } } } },
    ];
    assert.deepEqual(replayConversationHistory(events), [{ role: "assistant", content: "仅 delta" }]);
  });
});

describe("conversationReply", () => {
  test("reply is trimmed of think blocks", async () => {
    const r = await conversationReply(EP, [{ role: "user", content: "hi" }], "what?", {
      chat: async () => "<think>let me answer</think>It's a parser. ",
    });
    assert.equal(r, "It's a parser.");
  });

  test("failure → fallback reply", async () => {
    const r = await conversationReply(EP, [], "hi", {
      chat: async () => {
        throw new Error("boom");
      },
    });
    assert.ok(r.length > 0);
  });
});
