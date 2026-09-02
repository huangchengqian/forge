import type { TaskSession } from "../shared/types.ts";

export type ErrorEntry = {
  category: "provider" | "runtime" | "verification" | "evaluation" | "general";
  message: string;
  suggestion: string;
  severity: "error" | "warning";
};

export function collectErrors(task: TaskSession): readonly ErrorEntry[] {
  const out: ErrorEntry[] = [];
  if (task.failureReason) {
    out.push(classifyError(task.failureReason));
  }
  for (const o of task.observations) {
    if (o.result !== "FAIL") continue;
    if (!o.failureReason) continue;
    if (/auth|401|403|unauthorized/i.test(o.failureReason)) {
      out.push({ category: "provider", message: o.failureReason,
        suggestion: "Check your API key in Settings → Provider", severity: "error" });
    } else if (/timeout|deadline/i.test(o.failureReason)) {
      out.push({ category: "runtime", message: o.failureReason,
        suggestion: "The step took too long. Try increasing the deadline or simplifying the goal.", severity: "warning" });
    } else {
      out.push({ category: "verification", message: o.failureReason,
        suggestion: "Try resuming the task, or cancel and create a new one with a clearer goal.", severity: "warning" });
    }
  }
  if (task.lastEvaluation?.findings) {
    for (const f of task.lastEvaluation.findings) {
      if (f.severity === "critical" || f.severity === "warning") {
        out.push({ category: "evaluation",
          message: `${f.rule}: ${f.message}`,
          suggestion: "Review the evaluation findings in the task detail view.",
          severity: f.severity === "critical" ? "error" : "warning" });
      }
    }
  }
  return out;
}

function classifyError(reason: string): ErrorEntry {
  if (/auth|401|403|invalid api key|unauthorized/i.test(reason)) {
    return { category: "provider", message: reason,
      suggestion: "Your API key may have expired. Update it in Settings → Provider.", severity: "error" };
  }
  if (/exited unexpectedly|spawn error|ENOENT.*rpc-entry/i.test(reason)) {
    return { category: "runtime", message: reason,
      suggestion: "The runtime crashed. Try resuming the task from the Tasks page.", severity: "error" };
  }
  if (/budget exhausted|retry limit|max attempts/i.test(reason)) {
    return { category: "verification", message: reason,
      suggestion: "Too many failed attempts. Consider breaking this into smaller tasks.", severity: "warning" };
  }
  return { category: "general", message: reason,
    suggestion: "Try resuming the task or creating a new one with a clearer description.", severity: "error" };
}
