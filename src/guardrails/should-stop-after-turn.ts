import type {
  AgentMessage,
  ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import { validate } from "../verification/validate.ts";
import { DeterministicEvaluator } from "../evaluation/deterministic-evaluator.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import type { GuardrailConfig } from "./types.ts";

const MAX_RECOVERY = 3;

function steer(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/**
 * The turn-boundary gatekeeper — the heart of "don't trust 'model says done'".
 *
 * Order of checks (each layer can veto the ones after it):
 * 1. Transparent error recovery (error withholding, 参考 Claude Code):
 *    truncated / empty / API-error turns get steering retries (max 3 each)
 *    before anything is surfaced — a transient provider hiccup must never
 *    kill a long-running session.
 * 2. Hard stoppers: cost budget exhausted, maxTurns reached.
 * 3. Model still working (stopReason === "toolUse") → never stop. Running
 *    verification mid-work would both corrupt the run and burn budget.
 * 4. Model intends to stop → completion verification by trust level:
 *    low = accept, medium = criteria/project checks, high = all criteria +
 *    deterministic evaluator. Verification failure injects steering
 *    ("Verification failed. Please fix.") and returns false — the loop
 *    continues; abandonment is decided by maxTurns/maxCost/stuck, explicitly.
 */
export function makeShouldStopAfterTurn(config: GuardrailConfig) {
  const evaluator = new DeterministicEvaluator();
  let turnCount = 0;
  const recoveryCounts = new Map<string, number>();
  const verificationRound: { round: number; lastPassed: boolean | null } = { round: 0, lastPassed: null };

  const recordVerification = async (passed: boolean, reason?: string): Promise<void> => {
    verificationRound.round++;
    verificationRound.lastPassed = passed;
    await appendEvent(config.sessionId, "VERIFICATION_RESULT", {
      round: verificationRound.round,
      passed,
      reason: reason ?? null,
    }).catch(() => {});
  };

  return async (ctx: ShouldStopAfterTurnContext): Promise<boolean> => {
    turnCount++;
    const message = ctx.message;
    const stopReason = (message as { stopReason?: string }).stopReason ?? "";
    const content = (message as { content?: unknown }).content;

    // --- 1. Transparent error recovery (before any stop intent logic) ---
    if (stopReason === "error") {
      const count = (recoveryCounts.get("error") ?? 0) + 1;
      recoveryCounts.set("error", count);
      if (count <= MAX_RECOVERY) {
        const errText =
          (message as { errorMessage?: string }).errorMessage ?? "unknown API error";
        config.steeringQueue.push(
          steer(`A provider error occurred (${errText}). Assess the state and continue the task.`),
        );
        return false;
      }
      const surface =
        (message as { errorMessage?: string }).errorMessage ?? "provider error after retries";
      config.session.failureReason = surface;
      await recordVerification(false, surface);
      return true; // recovery exhausted — surface to the user
    }

    if (stopReason === "length" || stopReason === "max_tokens") {
      const count = (recoveryCounts.get("truncated") ?? 0) + 1;
      recoveryCounts.set("truncated", count);
      if (count <= MAX_RECOVERY) {
        config.steeringQueue.push(
          steer("Your output was truncated. Continue exactly where you left off."),
        );
        return false;
      }
      // exhausted → let the stop happen, the model's partial state stands.
      return true;
    }

    const isEmpty =
      stopReason === "stop" &&
      (!Array.isArray(content) || content.length === 0 || (content as unknown[]).every((b) => !b));

    // --- 2. Hard stoppers ---
    if (config.costGuard.isExhausted()) {
      await recordVerification(false, "cost budget exhausted").catch(() => {});
      return true;
    }
    if (config.completion.maxTurns !== null && turnCount >= config.completion.maxTurns) {
      await recordVerification(false, "max turns reached").catch(() => {});
      return true;
    }

    // --- 3. Model still working → keep going ---
    if (stopReason === "toolUse") return false;

    // --- 4. Model intends to stop → verification by trust level ---
    const { trustLevel, criteria } = config.completion;

    if (trustLevel === "low") {
      return true; // model stops → done (chat / questions)
    }

    if (trustLevel === "medium" || trustLevel === "high") {
      let allPassed = true;
      let failureReasons: string[] = [];

      const checks =
        criteria.length > 0
          ? criteria
          : trustLevel === "medium"
            ? // No explicit criteria: fall back to the project check when a
              // package.json exists (npm test is on the command allowlist).
              []
            : [];

      for (const criterion of checks) {
        const result = await validate(criterion, config.workspace);
        if (!result.passed) {
          allPassed = false;
          failureReasons.push(result.message);
        }
      }

      if (trustLevel === "medium" && checks.length === 0) {
        // Default project check: npm test, only meaningful with a package.json.
        const hasPackageJson = await import("node:fs/promises").then(
          (fs) => fs.access(`${config.workspace}/package.json`).then(() => true).catch(() => false),
        );
        if (hasPackageJson) {
          const result = await validate(
            { kind: "command_exit_zero", command: "npm test" },
            config.workspace,
          );
          if (!result.passed) {
            allPassed = false;
            failureReasons.push(result.message);
          }
        }
      }

      if (!allPassed) {
        await recordVerification(false, failureReasons.join("; ")).catch(() => {});
        config.steeringQueue.push(
          steer(
            `Verification failed: ${failureReasons.join("; ")}. Fix the issue and try to complete the task again.`,
          ),
        );
        return false; // loop continues; abandonment is maxTurns/maxCost/stuck
      }

      if (trustLevel === "high") {
        const evalResult = await evaluator.evaluate({ session: config.session });
        config.session.lastEvaluation = evalResult;
        if (evalResult.status === "REVIEW_REQUIRED") {
          await recordVerification(false, "evaluator flagged review-required findings").catch(
            () => {},
          );
          config.steeringQueue.push(
            steer("The deterministic evaluator flagged critical findings. Address them."),
          );
          return false;
        }
      }

      await recordVerification(true).catch(() => {});
      return true; // verified done
    }

    return true;
  };
}