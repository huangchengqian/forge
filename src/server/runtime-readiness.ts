import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../runtime/interface.ts";

export type RuntimeCheckResult = {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  message: string;
};

export type RuntimeReadinessResult = {
  status: "PASS" | "FAIL";
  checks: readonly RuntimeCheckResult[];
};

export async function checkRuntime(
  runtime: AgentRuntime,
  opts: {
    forgeHome: string;
    provider: string;
    modelId: string;
    env?: Record<string, string>;
  },
): Promise<RuntimeReadinessResult> {
  const checks: RuntimeCheckResult[] = [];
  const taskId = `readiness_${randomUUID().slice(0, 6)}`;
  // Dedicated Forge-owned sandbox: the readiness check writes a marker file and
  // runs bash, so it must never point at the forge home root or a user project.
  const workspace = join(opts.forgeHome, "readiness", taskId);

  // --- createSession ---
  let session;
  try {
    session = await runtime.createSession({
      taskId,
      goal: "readiness check",
      workspace,
      model: { provider: opts.provider, modelId: opts.modelId },
      env: opts.env,
    });
    checks.push({ name: "runtime_session", status: "PASS", message: `session ${session.id} created` });
  } catch (err) {
    checks.push({
      name: "runtime_session",
      status: "FAIL",
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: "FAIL", checks };
  }

  try {
    // --- basic turn ---
    try {
      const r = await runtime.prompt(session, "Say exactly: ok", { deadlineMs: 30_000 });
      if (r.success && r.text.toLowerCase().includes("ok")) {
        checks.push({ name: "basic_turn", status: "PASS", message: `response: "${r.text.slice(0, 50)}"` });
      } else if (r.success) {
        checks.push({ name: "basic_turn", status: "PASS", message: `response received (${r.text.length} chars)` });
      } else {
        checks.push({ name: "basic_turn", status: "FAIL", message: r.error ?? "unexpected response" });
      }
    } catch (err) {
      checks.push({
        name: "basic_turn",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // --- tool invocation ---
    try {
      const markerFile = "forge-readiness-marker.txt";
      await runtime.prompt(
        session,
        `Create a file named "${markerFile}" in the current directory containing exactly the text "runtime-ready". Use the write_file or bash tool.`,
        { deadlineMs: 60_000 },
      );
      const content = await readFile(join(session.directory, markerFile), "utf8").catch(() => "");
      if (content.includes("runtime-ready")) {
        checks.push({ name: "agent_tool_call", status: "PASS", message: "agent successfully wrote file via tool" });
      } else {
        checks.push({ name: "agent_tool_call", status: "FAIL", message: "marker file not found after prompt" });
      }
    } catch (err) {
      checks.push({
        name: "agent_tool_call",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // --- structured output ---
    try {
      const planPrompt =
        'Output a single JSON object with key "suggestedSteps" whose value is an array of objects. ' +
        'Each object has "intent" (string). For example: {"understanding":"test","suggestedSteps":[{"intent":"do x"}]}. ' +
        "Output ONLY the JSON, no markdown fences or other text.";
      const r = await runtime.prompt(session, planPrompt, { deadlineMs: 30_000 });
      if (r.success && r.text) {
        const cleaned = r.text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.suggestedSteps && Array.isArray(parsed.suggestedSteps)) {
          checks.push({
            name: "planner_structured_output",
            status: "PASS",
            message: `valid JSON plan with ${parsed.suggestedSteps.length} step(s)`,
          });
        } else {
          checks.push({ name: "planner_structured_output", status: "FAIL", message: "JSON missing suggestedSteps" });
        }
      } else {
        checks.push({ name: "planner_structured_output", status: "FAIL", message: r.error ?? "no response" });
      }
    } catch (err) {
      checks.push({
        name: "planner_structured_output",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    // --- cleanup ---
    try {
      await runtime.destroy(session);
      checks.push({ name: "cleanup", status: "PASS", message: "runtime session destroyed" });
    } catch (err) {
      checks.push({
        name: "cleanup",
        status: "FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // The sandbox is Forge-owned (created for this check), so removing it here
    // is safe. Runtimes themselves never delete workspaces (see interface contract).
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  const hasFail = checks.some((c) => c.status === "FAIL");
  return { status: hasFail ? "FAIL" : "PASS", checks };
}
