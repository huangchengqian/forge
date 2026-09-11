/**
 * Phase 3 smoke test: the verify-fix loop.
 *
 * Scripted LLM with high trust + criteria (hello.txt must contain "export"):
 * turn 1 writes the file WITHOUT export, turn 2 declares done -> verification
 * FAILS -> steering injected ("Verification failed... Fix."), turn 3 writes
 * the fix, turn 4 stops -> verification PASSES -> session ends verified.
 *
 * This exercises the full shouldStopAfterTurn pipeline: stop-intent gating,
 * criteria validation, steering injection, and the loop continuing on failure.
 */
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../agent-runner.ts";
import { appendEvent, readEvents } from "../core/persistence/event-log.ts";
import { UsageTracker } from "../guardrails/usage-tracker.ts";
import type { GuardrailConfig } from "../guardrails/types.ts";
import type { Session } from "../types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      },
    );
  }
}

const fakeModel = {
  id: "scripted",
  provider: "scripted",
  api: "openai-responses",
  name: "Scripted Mock",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
} as unknown as Model<any>;

function scriptedAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "scripted",
    model: "scripted",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "forge-verify-smoke-"));
  const sessionId = `session_verify_${Date.now()}`;
  process.env.FORGE_EVENTS_DIR = join(workspace, ".forge-events");
  process.env.FORGE_SESSIONS_DIR = join(workspace, ".forge-sessions");

  const session: Session = {
    id: sessionId,
    kind: "task",
    goal: "create hello.ts exporting a hello function",
    workspace,
    projectId: null,
    model: { provider: "scripted", modelId: "scripted" },
    messages: [],
    status: "running",
    failureReason: null,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    trustLevel: "high",
    thinkingLevel: "off",
    completionCriteria: [{ kind: "file_contains", path: "hello.txt", pattern: "export" }],
    lastEvaluation: null,
    maxTurns: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveAndLog(session);

  // Scripted behavior: buggy file first, "done", then the fix, then stop.
  const script: Array<() => AssistantMessage> = [
    () =>
      scriptedAssistantMessage(
        [
          {
            type: "toolCall",
            id: "call-1",
            name: "write",
            arguments: { path: join(workspace, "hello.txt"), content: "hello world\n" },
          },
        ],
        "toolUse",
      ),
    () => scriptedAssistantMessage([{ type: "text", text: "Done! hello.txt created." }]),
    () =>
      scriptedAssistantMessage(
        [
          {
            type: "toolCall",
            id: "call-2",
            name: "write",
            arguments: {
              path: join(workspace, "hello.txt"),
              content: "export function hello(): string {\n  return 'hello world';\n}\n",
            },
          },
        ],
        "toolUse",
      ),
    () => scriptedAssistantMessage([{ type: "text", text: "Fixed — export added." }]),
  ];
  let callIndex = 0;
  const streamFn: StreamFn = () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      const next = script[Math.min(callIndex, script.length - 1)];
      const message = next ? next() : scriptedAssistantMessage([{ type: "text", text: "done" }]);
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse" | "length" | "deferred",
        message,
      });
      callIndex++;
    });
    return stream;
  };

  const steeringQueue: AgentMessage[] = [];
  const guardrails: GuardrailConfig = {
    sessionId,
    workspace,
    undoRoot: join(workspace, ".forge-undo"),
    session,
    completion: {
      trustLevel: "high",
      criteria: session.completionCriteria,
      
      maxTurns: 12,
    },
    approval: { request: async () => true },
    steeringQueue,
    usage: new UsageTracker(),
  };

  const final = await runAgent({
    session,
    model: fakeModel,
    guardrails,
    streamFn,

  });

  const helloPath = join(workspace, "hello.txt");
  const content = existsSync(helloPath) ? readFileSync(helloPath, "utf8") : "";
  const events = await readEvents(sessionId);
  const verificationEvents = events.filter((e) => e.type === "VERIFICATION_RESULT");
  const sequence = verificationEvents.map((e) => (e.payload as { passed?: boolean }).passed);

  console.log(`  final file: ${JSON.stringify(content.slice(0, 80))}`);
  console.log(`  verification sequence: ${JSON.stringify(sequence)} (expect [false, true])`);
  console.log(`  loop turns: ${final.messages.length} message(s) across the fixed run`);
  console.log(`  failureReason: ${final.failureReason}`);

  // The loop ran to natural termination after a failed verification pulled
  // the agent back to fix the file — that is the whole verify-fix contract.
  const ok =
    content.includes("export") &&
    sequence.length === 2 &&
    sequence[0] === false &&
    sequence[1] === true &&
    final.failureReason === null;
  console.log(`\nVERIFY-LOOP SMOKE: ${ok ? "PASS" : "FAIL"}`);
  rmSync(workspace, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}

async function saveAndLog(session: Session): Promise<void> {
  const { saveSession } = await import("../core/persistence/session-store.ts");
  await saveSession(session);
  await appendEvent(session.id, "SESSION_CREATED", { goal: session.goal });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
