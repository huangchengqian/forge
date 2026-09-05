import { resolve, relative, sep } from "node:path";
import { defaultPolicyPath, evaluateToolCall, loadPolicy } from "../guard/policy.ts";

/**
 * Verification is Forge-owned and therefore must not become an unguarded
 * backdoor around Pi's tool policy. Only a small, argv-like set of common
 * project checks may run automatically. Everything else is evaluated through
 * the same Guard rules as an agent `bash` call and is denied when it would
 * require interactive approval (the verification API has no approval channel).
 */
const REGISTERED_CHECKS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|build))(?:\s+--[\w=-]+)*$/,
  // `npx tsc --noEmit`, including npx flags like `-y -p typescript@5` that the
  // skill registry emits for a hermetic typecheck.
  /^npx(?:\s+-[a-z](?:\s+[^\s-][\w@./-]*)?)*\s+tsc\s+--noEmit(?:\s+--[\w-]+(?:\s+[^\s-][\w./-]*)?)*(?:\s+[^\s-][\w./-]*)?$/,
  /^node\s+--test(?:\s+[./\w-]+)*$/,
];

export type CommandDecision =
  | { allowed: true; source: "registered" | "guard" }
  | { allowed: false; reason: string };

export function resolveWithinWorkspace(workspace: string, path: string | undefined): string {
  if (!path) return resolve(workspace);
  // Absolute paths are intentionally rejected, including an absolute path
  // that happens to point inside the workspace: criteria should be portable
  // and must not select an arbitrary host directory.
  if (path.startsWith("/")) throw new Error("absolute verification paths are not allowed");
  const root = resolve(workspace);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
    if (rel === "") return target;
    throw new Error("verification path escapes the task workspace");
  }
  return target;
}

export function decideCommand(command: string): CommandDecision {
  const normalized = command.trim();
  if (REGISTERED_CHECKS.some((pattern) => pattern.test(normalized))) {
    return { allowed: true, source: "registered" };
  }
  const decision = evaluateToolCall(loadPolicy(defaultPolicyPath()), "bash", { command: normalized });
  if (decision.action === "allow") return { allowed: true, source: "guard" };
  return {
    allowed: false,
    reason: decision.action === "ask"
      ? "custom verification command requires an explicit Forge Guard allow rule"
      : `custom verification command denied: ${decision.reason}`,
  };
}

/** Keep only execution-neutral locale/path values; credentials never reach verification. */
export function verificationEnv(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: resolve(workspace, ".forge-verify-home") };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TERM"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
