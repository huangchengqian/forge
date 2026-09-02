/**
 * Forge Guard — Pi extension entry (Amendment A-2, 9.6.4).
 *
 * Loaded by the Pi subprocess via `--extension <this file>`. Implements the
 * Pi `tool_call` event: evaluates the tool call against the guard policy and
 * either passes it, blocks it (optionally terminating), or asks the user via
 * the RPC UI channel (`extension_ui_request`/`extension_ui_response`).
 *
 * Deliberately zero Pi-package imports: it runs inside the Pi process (jiti)
 * and must not depend on Forge's own modules beyond the policy model. The Pi
 * extension types are structurally mirrored below.
 */

import { loadPolicy, evaluateToolCall, summarizeInput, defaultPolicyPath, type GuardPolicy, type DecisionOutcome } from "./policy.ts";
import { journalFile } from "./journal.ts";

/** Structural mirror of Pi's ToolCallEvent (see pi packages/agent/src/types.ts). */
export type ToolCallEvent = {
  type: "tool_call";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
};

/** Structural mirror of Pi's ToolCallEventResult. */
export type ToolCallEventResult = {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
};

/** Structural mirror of Pi's ExtensionUIContext.confirm. */
export type GuardUi = {
  confirm: (title: string, message: string, opts?: { timeout?: number }) => Promise<boolean>;
};

/** Structural mirror of Pi's ExtensionContext (the parts we use). */
export type GuardContext = {
  ui: GuardUi;
  hasUI: boolean;
  cwd: string;
};

export type GuardApi = {
  on: (event: "tool_call", handler: (event: ToolCallEvent, ctx: GuardContext) => Promise<ToolCallEventResult | undefined>) => void;
};

export const APPROVAL_TIMEOUT_MS = 60_000;

/**
 * What an `ask` decision does when Forge has no approval consumer wired.
 * - "block" (default): emit the RPC UI request and block until a response
 *   (or the 60s timeout → auto-deny). Used when the approval relay is live.
 * - "allow": pass through without prompting. Used by headless CLI runs that
 *   have no UI surface to answer approvals.
 */
function askFallbackMode(): "allow" | "block" {
  return process.env.FORGE_GUARD_ASK_FALLBACK === "allow" ? "allow" : "block";
}

/** Build the tool_call handler for a given policy (unit-testable). */
export function makeGuardHandler(policy: GuardPolicy, opts: { askFallback?: "allow" | "block" } = {}) {
  const askFallback = opts.askFallback ?? askFallbackMode();
  return async (event: ToolCallEvent, ctx: GuardContext): Promise<ToolCallEventResult | undefined> => {
    try {
      const decision: DecisionOutcome = evaluateToolCall(policy, event.toolName, event.input);

      if (decision.action === "deny") {
        const result: ToolCallEventResult = { block: true, reason: decision.reason };
        if (decision.terminate) result.terminate = true;
        return result;
      }

      if (decision.action === "ask") {
        if (askFallback === "allow") {
          return undefined;
        }
        if (!ctx.hasUI) {
          return { block: true, reason: "forge-guard: approval required but no UI is available" };
        }
        const ok = await ctx.ui.confirm(`Allow ${event.toolName}?`, summarizeInput(event.toolName, event.input), {
          timeout: APPROVAL_TIMEOUT_MS,
        });
        if (!ok) return { block: true, reason: "forge-guard: rejected by user" };
      }

      // The tool will execute — journal file mutations first (best-effort).
      if ((event.toolName === "write" || event.toolName === "edit") && typeof event.input.path === "string") {
        await journalFile(ctx.cwd, event.input.path);
      }
      return undefined;
    } catch (err) {
      // Fail closed: any policy/extension error blocks the tool.
      return { block: true, reason: `forge-guard error: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

/**
 * Pi extension factory. `pi.on("tool_call", handler)` is the documented
 * subscription API for the tool_call event (verified in pi-agent-core).
 *
 * The policy file is re-read on every tool call so "always allow" rules
 * written to guard.json while a task is running take effect immediately
 * (no Pi restart needed). The file is ~1KB; the read is negligible.
 */
export default function forgeGuard(pi: GuardApi): void {
  pi.on("tool_call", (event: ToolCallEvent, ctx: GuardContext) =>
    makeGuardHandler(loadPolicy(defaultPolicyPath()))(event, ctx),
  );
}
