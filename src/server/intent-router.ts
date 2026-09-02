import { callProvider, extractResponseText, type ProviderEndpoint } from "./provider-api.ts";
import type { ForgeConfig, ProviderConfig } from "./config-store.ts";

/**
 * Phase 9.7 Intent Router.
 *
 * Routes the FIRST message of a session onto one of two paths:
 *   - "conversation": a plain chat reply, produced by a single server-side
 *     mini completion (no Pi runtime, no plan, no state machine). The reply
 *     is returned in the same call so a conversation costs exactly one model
 *     call.
 *   - "task": the input is an engineering request; the caller falls through
 *     to the existing TaskManager.create() → Orchestrator pipeline.
 *
 * Deliberately decoupled from PiRuntime: classification is a stateless
 * server-side completion over the configured provider. When classification
 * fails (unparseable output, network error, no provider configured) we err
 * toward "task" — routing a chat into the task pipeline degrades gracefully
 * (the planner already handles non-tasks), while routing a real engineering
 * request into chat would swallow it.
 */

export type IntentKind = "conversation" | "task";

export type IntentResult =
  | { kind: "conversation"; reply: string }
  | { kind: "task" };

export type ChatMessage = { role: "user" | "assistant"; content: string };

export const FALLBACK_REPLY =
  "I couldn't route that conversationally. Could you rephrase, or let me know if you want me to change something in the workspace?";

/** Build a provider endpoint from the saved config (mirrors provider-check semantics). */
export function endpointFromConfig(cfg: ForgeConfig): ProviderEndpoint | null {
  const p = cfg.provider;
  if (!p) return null;
  return endpointFromProvider(p);
}

export function endpointFromProvider(p: ProviderConfig): ProviderEndpoint {
  const api = p.api ?? (p.kind === "openai-compatible" ? "openai-completions" : undefined);
  return {
    kind: p.kind,
    apiKey: p.apiKey,
    modelId: p.modelId,
    baseUrl: p.baseUrl,
    ...(api !== undefined ? { api } : {}),
  };
}

const ROUTER_SYSTEM_PROMPT = `You are Forge's intent router. Decide whether the user's input is an engineering task on the current project workspace, or plain conversation.

Classify as "task" when the user explicitly asks an agent to perform an engineering action on the workspace, including: creating files, modifying/deleting code, fixing bugs, refactoring, writing tests, running tests, executing commands, debugging, building, installing dependencies, changing configuration, git operations, analyzing the project AND then modifying it, or any request that requires operating on the workspace.

Classify as "conversation" for: casual chat, Q&A, concept explanation, summarization, translation, discussion, advice, or code analysis that does NOT require changing the workspace.

Rules:
- If the request mixes discussion AND an actual modification, classify as "task".
- "帮我看看这个 bug 是什么原因，然后修掉" (help me find the cause of this bug, then fix it) -> task
- "这个 bug 一般是什么原因？" (what usually causes this kind of bug?) -> conversation
- An explicit request to create/fix/refactor/test/run something in the workspace is ALWAYS "task", even if the user gave no code or context yet — the engineering agent will ask for details while executing.
- For "task", output ONLY: {"kind":"task"} — no reply field, no other text.
- For "conversation", output: {"kind":"conversation","reply":"<your direct reply to the user, in the user's language>"} — reply briefly (2-4 sentences) as a friendly assistant; you have NO file access and NO tools, so do not pretend to read files or run commands.
- Output ONLY one JSON object. No prose, no code fences. Keep the reply short so the JSON always closes.`;

function chatOnce(
  endpoint: ProviderEndpoint,
  system: string,
  messages: readonly ChatMessage[],
  maxTokens = 3000,
): Promise<string> {
  const openai = endpoint.api === "openai-completions" || endpoint.api === "openai-responses";
  const body: Record<string, unknown> = {
    model: endpoint.modelId,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      ...messages.map((m) =>
        openai
          ? { role: m.role, content: m.content }
          : { role: m.role, content: [{ type: "text", text: m.content }] },
      ),
    ],
  };
  return callProvider(endpoint, body).then((res) => extractResponseText(res, endpoint.api));
}

/**
 * Extract a JSON intent object from model output. Reasoning models may
 * prefix <think> blocks and some providers wrap JSON in fences; strip both,
 * then fall back to the outermost {...} so trailing prose is ignored. If the
 * JSON is truncated (long conversation replies cut by max_tokens), recover
 * the kind by regex prefix so a cut-off reply never misroutes a chat into the
 * task pipeline.
 */
export function extractIntentJson(text: string): { kind: string; reply?: unknown } | null {
  let candidate = text
    .replace(/<\s*think\s*>[\s\S]*?<\/\s*think\s*>/g, " ")
    .trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) candidate = candidate.slice(start, end + 1);
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    if (obj && typeof obj.kind === "string") {
      return { kind: obj.kind, reply: obj.reply };
    }
  } catch {
    /* fall through to prefix recovery */
  }
  // Truncation recovery: the object did not parse (likely an unclosed reply).
  // A leading kind marker is still trustworthy — use it, and salvage whatever
  // reply prefix arrived before the cut.
  const kindMatch = candidate.match(/"kind"\s*:\s*"(conversation|task)"/);
  if (!kindMatch) return null;
  const kind = kindMatch[1]!;
  if (kind === "task") return { kind };
  const replyMatch = candidate.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  return { kind, reply: replyMatch?.[1] ?? undefined };
}

export type RouterOptions = {
  /** Replace the model call (unit tests). */
  chat?: (endpoint: ProviderEndpoint, system: string, messages: readonly ChatMessage[], maxTokens?: number) => Promise<string>;
};

/**
 * Rule pre-check for unambiguous engineering requests. Reasoning models
 * sometimes classify a bare imperative ("修复这个 bug") as conversation when
 * the code context is missing — routing it to chat would swallow the request.
 * The rules only fire on high-confidence task signals and never on
 * educational/explanation questions; everything else is left to the LLM.
 * Returns a task verdict or null (let the model decide).
 */
export function ruleCheck(input: string): { kind: "task" } | null {
  const s = input.trim();
  // Educational/explanation questions ("重构的好处", "修复 bug 一般是什么原因") are
  // for the model — UNLESS they also carry an execution request ("...然后修掉").
  const ask = /(是什么|什么是|为什么|好处|优点|区别|差异|怎么看|怎么理解|如何理解|介绍一下|解释|总结|讲讲|翻译|说说|你觉得|你认为|请教)/.test(s);
  const execLink = /(然后|并且|并请|接着|顺便|再)/.test(s) && /(修|改|建|删|写|跑|执行|重构|实现)/.test(s);
  const verb = /(修复|修一下|修掉|创建|新建|删除|移除|重构|运行|执行|调试|构建|编译|安装|写入|生成|修改|改动|实现|开发|git\s+\w+|跑(?:一下|下|个)?测试|写(?:个|一|下)?测试)/i.test(s);
  if (!verb) return null;
  if (ask && !execLink) return null;
  const object = /(bug|错误|问题|文件|代码|函数|方法|模块|类|接口|测试|脚本|依赖|配置|组件|页面|仓库|分支|需求|功能)/i.test(s);
  // Short bare imperatives ("修复 bug", "跑测试") are high confidence even
  // without an object token; long phrases without an object go to the model.
  if (!object && s.length > 24) return null;
  return { kind: "task" };
}

/**
 * Single-call classify-and-reply for the FIRST message of a session.
 * Conversation: costs exactly one mini completion and returns the reply.
 * Task: returns { kind: "task" } with no reply (planning happens later in
 * the orchestrator). Unrecoverable classification -> "task" (conservative).
 */
export async function classifyIntent(
  endpoint: ProviderEndpoint,
  input: string,
  opts: RouterOptions = {},
): Promise<IntentResult> {
  const ruled = ruleCheck(input);
  if (ruled) return ruled;
  const chat = opts.chat ?? chatOnce;
  const userPrompt =
    `User input: ${input}\n` +
    `Classify it and output the JSON object described above.`;
  let text = "";
  try {
    text = await chat(endpoint, ROUTER_SYSTEM_PROMPT, [{ role: "user", content: userPrompt }]);
  } catch {
    return { kind: "task" };
  }
  const parsed = extractIntentJson(text);
  if (!parsed) return { kind: "task" };
  if (parsed.kind === "conversation") {
    const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : FALLBACK_REPLY;
    return { kind: "conversation", reply };
  }
  return { kind: "task" };
}

const CHAT_SYSTEM_PROMPT = `You are Forge, a friendly coding assistant having a conversation with the user inside their project workspace. You have NO tools and NO file access in this mode. Answer clearly and concisely in the user's language. Do not invent file contents or pretend to have read files. If the user asks you to actually modify code, run commands, or inspect files, tell them you'll need to start an engineering task for that, and suggest rephrasing as a concrete task.`;

/**
 * Continued-turn reply for an existing "conversation" session. History is
 * replayed from the session's event log (single source of truth) so the
 * model can answer follow-ups like "summarize what you just said".
 */
export async function conversationReply(
  endpoint: ProviderEndpoint,
  history: readonly ChatMessage[],
  userText: string,
  opts: RouterOptions = {},
): Promise<string> {
  const chat = opts.chat ?? chatOnce;
  const messages: ChatMessage[] = [...history, { role: "user", content: userText }];
  try {
    const text = await chat(endpoint, CHAT_SYSTEM_PROMPT, messages);
    const cleaned = text
      .replace(/<\s*think\s*>[\s\S]*?<\/\s*think\s*>/g, " ")
      .trim();
    return cleaned.length > 0 ? cleaned : FALLBACK_REPLY;
  } catch {
    return FALLBACK_REPLY;
  }
}

/**
 * Replay a conversation session's persisted events into (role, content)
 * pairs for the stateless chat channel. Mirrors the desktop's rendering: Pi
 * message_update/text_delta deltas accumulate into assistant messages;
 * user_message events are user turns. Thinking blocks are stripped so they
 * are not re-fed to the model. Keeps at most the last `maxTurns` user turns.
 */
export function replayConversationHistory(
  events: readonly { type?: string; payload?: { piEvent?: Record<string, unknown> } }[],
  maxTurns = 8,
): ChatMessage[] {
  interface RawTurn { role: "user" | "assistant"; text: string }
  const turns: RawTurn[] = [];
  let assistantBuf = "";

  const flushAssistant = () => {
    const cleaned = assistantBuf
      .replace(/<\s*think\s*>[\s\S]*?<\/\s*think\s*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length > 0) turns.push({ role: "assistant", text: cleaned });
    assistantBuf = "";
  };

  for (const e of events) {
    if (e.type !== "AGENT_EVENT") continue;
    const pe = e.payload?.piEvent;
    if (!pe) continue;
    if (pe.type === "user_message") {
      flushAssistant();
      if (typeof pe.text === "string" && pe.text.trim()) {
        turns.push({ role: "user", text: pe.text.trim() });
      }
    } else if (pe.type === "message_update") {
      const ame = (pe as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        assistantBuf += ame.delta;
      }
    } else if (pe.type === "turn_error") {
      flushAssistant();
    } else if (pe.type === "tool_call" || pe.type === "tool_execution_start") {
      // A conversation session never runs tools today; if a future path does,
      // stop the current assistant message before the tool boundary.
      flushAssistant();
    }
  }
  flushAssistant();

  // Trim to the last maxTurns user turns (+ their assistant replies).
  const userIndexes: number[] = [];
  turns.forEach((t, i) => { if (t.role === "user") userIndexes.push(i); });
  const drop = Math.max(0, userIndexes.length - maxTurns);
  if (drop > 0) {
    const firstKeep = userIndexes[drop] ?? 0;
    return turns.slice(firstKeep).map((t) => ({ role: t.role, content: t.text }));
  }
  return turns.map((t) => ({ role: t.role, content: t.text }));
}
