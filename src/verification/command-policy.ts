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
  | { allowed: true; source: "registered" | "readonly" | "guard" }
  | { allowed: false; reason: string };

/**
 * Binaries that only read and never write. Models habitually verify artifacts
 * with `cat`/`ls`/`grep`-style reads; without an allowance those burn the
 * whole FIX budget on "verification command denied" while the artifact itself
 * was correct. Each segmented command must consist solely of these.
 */
const READ_ONLY_BINARIES = new Set([
  "cat", "ls", "head", "tail", "wc", "stat", "file", "grep", "diff", "du", "test", "[",
]);

/** find subcommands that execute or delete — never read-only. */
const FORBIDDEN_FIND_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fork"]);

/** Anything that spawns, substitutes, redirects, or sequences escapes the read-only analysis. */
const UNSAFE_SHELL_CHARS = /[;&<>`$(){}]/;

export function isReadOnlyVerification(command: string): boolean {
  const normalized = command.trim();
  if (!normalized || UNSAFE_SHELL_CHARS.test(normalized)) return false;
  for (const segment of normalized.split("|")) {
    const words = segment.trim().split(/\s+/);
    if (!words[0] || !READ_ONLY_BINARIES.has(words[0])) return false;
    for (const arg of words.slice(1)) {
      if (arg.startsWith("/")) return false; // absolute paths may read outside the workspace
      if (arg.split("/").includes("..")) return false; // no upward path escapes
      if (words[0] === "find" && FORBIDDEN_FIND_FLAGS.has(arg)) return false;
    }
  }
  return true;
}

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
  if (isReadOnlyVerification(normalized)) {
    return { allowed: true, source: "readonly" };
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
