import { beforeEach, describe, expect, test, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunkSets.shift() ?? [];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function model(): Model<"openai-completions"> {
	return {
		id: "minimax-m3-test",
		name: "MiniMax M3 Test",
		api: "openai-completions",
		provider: "minimax",
		baseUrl: "https://api.minimaxi.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-test",
		model: "minimax-m3-test",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

async function streamContent(contentChunks: string[]) {
	const chunks = [...contentChunks.map((text) => chunk({ content: text, role: "assistant" })), chunk({}, "stop")];
	mockState.chunkSets.push(chunks);
	const events: AssistantMessageEvent[] = [];
	const s = streamOpenAICompletions(
		model(),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test" },
	);
	for await (const event of s) {
		events.push(event);
	}
	await s.result();
	return events;
}

describe("openai-completions <think> tag routing", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
	});

	test("leading <think>...</think> routes reasoning into a thinking block, not text", async () => {
		const events = await streamContent([
			"<think>The user wants",
			" me to say hi.</think>\n\n",
			"Hello! How can I help?",
		]);

		const thinking = events
			.filter((e) => e.type === "thinking_delta")
			.map((e) => (e as any).delta)
			.join("");
		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e as any).delta)
			.join("");

		expect(thinking).toBe("The user wants me to say hi.");
		expect(text).toBe("Hello! How can I help?");
		expect(text).not.toContain("<think>");
		expect(text).not.toContain("</think>");
	});

	test("think tags split character-by-character across chunk boundaries still classify", async () => {
		const full = "<think>reasoning</think>The answer";
		const events = await streamContent(full.split("")); // one char per delta, worst case

		const thinking = events
			.filter((e) => e.type === "thinking_delta")
			.map((e) => (e as any).delta)
			.join("");
		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e as any).delta)
			.join("");

		expect(thinking).toBe("reasoning");
		expect(text).toBe("The answer");
	});

	test("content not starting with <think> passes through untouched", async () => {
		const events = await streamContent(["The answer mentions <think> tags", " in prose"]);

		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e as any).delta)
			.join("");
		const thinking = events
			.filter((e) => e.type === "thinking_delta")
			.map((e) => (e as any).delta)
			.join("");

		// Only a *leading* `<think>` opens reasoning; mid-text mentions pass through.
		expect(text).toBe("The answer mentions <think> tags in prose");
		expect(thinking).toBe("");
	});

	test("a literal leading <think> is inherently ambiguous and treated as reasoning (de-facto convention)", async () => {
		const events = await streamContent(["<think> is a tag I am describing"]);

		const thinking = events
			.filter((e) => e.type === "thinking_delta")
			.map((e) => (e as any).delta)
			.join("");
		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e as any).delta)
			.join("");

		expect(thinking).toBe(" is a tag I am describing");
		expect(text).toBe("");
	});

	test("unclosed <think> at end of stream is treated entirely as thinking", async () => {
		const events = await streamContent(["<think>stream got cut", " before the answer"]);

		const thinking = events
			.filter((e) => e.type === "thinking_delta")
			.map((e) => (e as any).delta)
			.join("");
		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => (e as any).delta)
			.join("");

		expect(thinking).toBe("stream got cut before the answer");
		expect(text).toBe("");
	});
});
