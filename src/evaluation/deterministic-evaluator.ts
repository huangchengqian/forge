import { spawn } from "node:child_process";
import type { EvaluationInput } from "./evaluator.ts";
import type { EvaluationResult, Finding, Evidence } from "../core/types/evaluation.ts";

/**
 * Deterministic post-completion scoring for the Session model. Plan/step
 * coverage checks from the state-machine era are gone (there is no plan);
 * what remains is what a Session can honestly answer for: turn/size sanity
 * and change-scope guardrails on the real git diff.
 */
export class DeterministicEvaluator {
  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const findings: Finding[] = [];
    const evidence: Evidence[] = [];
    const { session } = input;

    const turns = session.messages.filter((m) => m.role === "assistant").length;
    evidence.push({
      kind: "conversation_size",
      detail: `${session.messages.length} message(s), ${turns} assistant turn(s)`,
    });

    const diff = await gitDiffSummary(session.workspace);
    evidence.push({ kind: "change_scope", detail: diff.detail });
    if (diff.changedLines > 20_000) {
      findings.push({
        rule: "change_scope",
        severity: "critical",
        message: `abnormally large diff: ${diff.changedLines} changed lines`,
      });
    } else if (diff.changedLines > 5_000) {
      findings.push({
        rule: "change_scope",
        severity: "warning",
        message: `large diff: ${diff.changedLines} changed lines`,
      });
    }

    let score = 100;
    for (const f of findings) {
      score -= f.severity === "critical" ? 35 : 15;
    }
    score = Math.max(0, score);
    const hasCritical = findings.some((f) => f.severity === "critical");
    const status = hasCritical ? "REVIEW_REQUIRED" : findings.length > 0 ? "WARNING" : "PASS";

    return {
      sessionId: session.id,
      score,
      status,
      findings,
      evidence,
    };
  }
}

type DiffSummary = { changedLines: number; detail: string };

function gitDiffSummary(cwd: string): Promise<DiffSummary> {
  return new Promise((resolveP) => {
    const child = spawn("git", ["diff", "--numstat"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (errOut += c.toString("utf8")));
    child.on("error", () => resolveP({ changedLines: 0, detail: "git unavailable (skipped)" }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolveP({ changedLines: 0, detail: `not a git repo or diff failed (${(errOut || "no output").slice(0, 60).trim()})` });
        return;
      }
      let changed = 0;
      for (const line of out.split("\n")) {
        const parts = line.split("\t");
        const add = Number(parts[0]);
        const del = Number(parts[1]);
        if (Number.isFinite(add)) changed += add;
        if (Number.isFinite(del)) changed += del;
      }
      resolveP({ changedLines: changed, detail: `${changed} changed lines (uncommitted)` });
    });
  });
}
