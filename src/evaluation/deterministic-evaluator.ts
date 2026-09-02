import { spawn } from "node:child_process";
import type { EvaluationInput } from "./evaluator.ts";
import type { EvaluationResult, Finding, Evidence } from "../core/types/evaluation.ts";

export class DeterministicEvaluator {
  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const findings: Finding[] = [];
    const evidence: Evidence[] = [];
    const { task, plan, observations } = input;

    const steps = plan?.steps ?? [];
    const verified = steps.filter((s) => s.status === "verified");

    evidence.push({
      kind: "plan_coverage",
      detail: `${verified.length}/${steps.length} steps verified`,
    });
    if (steps.length === 0) {
      findings.push({ rule: "plan_coverage", severity: "critical", message: "plan missing or empty" });
    } else if (verified.length !== steps.length) {
      findings.push({
        rule: "plan_coverage",
        severity: "critical",
        message: `${steps.length - verified.length} step(s) not verified`,
      });
    }

    const totalCriteria = steps.reduce((n, s) => n + s.successCriteria.length, 0);
    evidence.push({
      kind: "verification_coverage",
      detail: `${totalCriteria} criteria across ${steps.length} steps; ${observations.length} observation(s)`,
    });
    if (totalCriteria === 0) {
      findings.push({
        rule: "verification_coverage",
        severity: "critical",
        message: "no success criteria defined in plan",
      });
    }
    if (observations.length < steps.length && steps.length > 0) {
      findings.push({
        rule: "verification_coverage",
        severity: "warning",
        message: `fewer observations (${observations.length}) than steps (${steps.length})`,
      });
    }

    let maxAttempts = 0;
    for (const s of steps) {
      if (s.attempts > maxAttempts) maxAttempts = s.attempts;
    }
    evidence.push({
      kind: "retry_quality",
      detail: `max step attempts=${maxAttempts}, task fixes=${task.fixCount}`,
    });
    if (maxAttempts >= 5) {
      findings.push({
        rule: "retry_quality",
        severity: "critical",
        message: `a step required ${maxAttempts} attempts`,
      });
    } else if (maxAttempts >= 3) {
      findings.push({
        rule: "retry_quality",
        severity: "warning",
        message: `a step required ${maxAttempts} attempts (repeated failures)`,
      });
    }
    if (task.fixCount >= 5) {
      findings.push({
        rule: "retry_quality",
        severity: "warning",
        message: `${task.fixCount} fix cycles consumed`,
      });
    }

    const diff = await gitDiffSummary(task.directory);
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
      taskId: task.id,
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
