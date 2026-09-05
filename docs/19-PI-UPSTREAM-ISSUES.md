# Pi runtime issues

Pi is vendored at `pi/` and part of this repo — we evolve it directly. Fix
these locally where they belong; the drafts below double as ready-made
upstream PR material (earendil-works/pi) if we choose to upstream.

## Issue 1: `<think>` from reasoning models leaks into assistant text (openai-completions)

**Title**: openai-completions: reasoning embedded as `<think>...</think>` in `delta.content` is not stripped and leaks into assistant text

**Environment**
- pi-ai `packages/ai/src/api/openai-completions.ts` (current main)
- Provider: MiniMax (OpenAI-compatible endpoint `https://api.minimaxi.com/v1`), model `MiniMax-M3`
- Same behavior expected with DeepSeek-R1-style endpoints that embed reasoning as a `<think>` prefix

**Reproduction**
1. `POST /v1/chat/completions` with `"stream": true` against MiniMax. Observe the raw SSE: the model's reasoning arrives **inside `delta.content`** wrapped in `<think>...</think>`, and **no `reasoning_content` / `reasoning` field is present**:

```
data: {"choices":[{"delta":{"content":"<think>The user wants me to ...</think>\n\nThe actual answer..."}}]}
```

2. In pi, every `delta.content` is appended to the assistant text block verbatim:

`packages/ai/src/api/openai-completions.ts` (stream handler):
```ts
if (choice.delta.content !== null && ...) {
    const block = ensureTextBlock();
    block.text += choice.delta.content;
    stream.push({ type: "text_delta", ..., delta: choice.delta.content });
}
```

There is handling for field-based reasoning (`reasoning_content` / `reasoning` /
`reasoning_text`, ~line 561) but **no handling for `<think>`-tagged reasoning
embedded in `content`** — which is what MiniMax (and several other providers)
emit by default.

**Impact**: thinking text pollutes assistant messages. Downstream consumers
that parse structured output from assistant text (planners) get corrupted or
prefixed payloads; UIs show internal reasoning.

**Suggested fix**: in the openai-completions stream handler, detect a leading
`<think>...</think>` segment in the accumulated text and route it to a
`thinking` content block instead of the text block (mirror of the existing
field-based reasoning path). This is a de-facto convention across
openai-compatible providers (DeepSeek-R1, Qwen, vLLM, MiniMax), so a single
generic handling covers many endpoints. Alternative: honor provider-configured
splitting (e.g. MiniMax `reasoning_split: true` → `reasoning_details`), but the
tag-based approach is broader.

---

## Issue 2: anthropic-messages stream: CJK text deltas get reordered (field corruption)

**Status: RESOLVED — root cause was in Forge, not pi.**

The suspected area below was wrong. Pi's entire streaming chain (pi-ai
`anthropic-messages.ts` → agent-loop → agent-session → rpc-mode stdout) is
strictly order-preserving — every hop either forwards deltas synchronously or
awaits them in sequence. The corruption came from Forge's own persistence:
`task-manager`'s `onPiEvent` issued one fire-and-forget `void appendEvent`
per delta, and the concurrent `appendFile` calls raced in the libuv
threadpool, scrambling the JSONL line order that the SSE stream (and the
desktop) consume as ordered truth. `message_end` was always clean because pi
emits it from the complete in-memory message.

Fixed in Forge (`src/core/persistence/event-log.ts`): per-task FIFO append
queue + regression test (`event-log-order.test.ts`, which fails against the
unchained implementation with a real reorder at position 3).

Original analysis kept for the record:

**Title**: anthropic-messages: streamed text deltas for CJK content arrive out of order / interleaved, corrupting JSON output

**Environment**
- pi-ai `packages/ai/src/api/anthropic-messages.ts`
- Provider: MiniMax Anthropic-compatible endpoint `https://api.minimaxi.com/anthropic`, model `MiniMax-M3`

**Reproduction**
1. Point pi at the MiniMax anthropic endpoint, run an agent prompt that yields a long structured JSON in Chinese (~600 chars, many streamed deltas).
2. Collect the `text_delta` events pi emits and concatenate them.
3. Observed: field names and adjacent words interleave. Example — the model
   intended `...写入飞书等）。","suggestedSteps":[]` but the concatenated stream
   contains `...写入飞` + `等）。","` + `书表格` + `edSteps":` + `suggest` + `[]}`.
   The characters of `书` (from 飞书) and `suggest` (from suggestedSteps) are swapped
   across delta boundaries. JSON parses fail downstream.

**Isolation evidence**
- `curl` directly against the same MiniMax endpoint with the same prompt: 93 SSE deltas, concatenated text is clean → provider endpoint is fine.
- A Forge-side consumer that only concatenates deltas in arrival order reproduces the corruption → corruption exists in the deltas pi emits, i.e. inside the anthropic-messages handling (SSE reassembly / multi-content-block delta routing), not in the endpoint and not in the consumer.

**Suspected area**: `anthropic-messages.ts` stream handling between
`iterateSseMessages` (SSE decode) and the `text_delta` event emission
(`contentIndex` routing / partial JSON scratch buffer), specifically with
multiple or interleaved content blocks on CJK text.

**Suggested next step**: add a streaming test that concatenates emitted
`text_delta`s and asserts equality with the raw SSE `text` concatenation for a
multi-block CJK fixture.
