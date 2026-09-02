import { access, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { CriterionResult, SuccessCriterion } from "../core/types/criterion.ts";

export async function validateFileExists(
  criterion: Extract<SuccessCriterion, { kind: "file_exists" }>,
  baseCwd: string,
): Promise<CriterionResult> {
  const full = resolvePath(criterion.path, baseCwd);
  try {
    await access(full);
    return ok(criterion, `file exists: ${full}`, { path: full });
  } catch (err) {
    return fail(criterion, `file not found: ${full}`, { path: full }, undefined, undefined, errMessage(err));
  }
}

export async function validateFileContains(
  criterion: Extract<SuccessCriterion, { kind: "file_contains" }>,
  baseCwd: string,
): Promise<CriterionResult> {
  const full = resolvePath(criterion.path, baseCwd);
  let content: string;
  try {
    content = await readFile(full, "utf8");
  } catch (err) {
    return fail(criterion, `cannot read file: ${full}`, { path: full }, undefined, undefined, errMessage(err));
  }
  if (content.includes(criterion.pattern)) {
    return ok(criterion, `file contains pattern: ${criterion.pattern}`, { path: full, pattern: criterion.pattern });
  }
  return fail(criterion, `file does not contain pattern: ${criterion.pattern}`, { path: full, pattern: criterion.pattern }, undefined, undefined, undefined);
}

export async function validateFileNotContains(
  criterion: Extract<SuccessCriterion, { kind: "file_not_contains" }>,
  baseCwd: string,
): Promise<CriterionResult> {
  const full = resolvePath(criterion.path, baseCwd);
  let content: string;
  try {
    content = await readFile(full, "utf8");
  } catch (err) {
    return fail(criterion, `cannot read file: ${full}`, { path: full }, undefined, undefined, errMessage(err));
  }
  if (!content.includes(criterion.pattern)) {
    return ok(criterion, `file does not contain pattern: ${criterion.pattern}`, { path: full, pattern: criterion.pattern });
  }
  return fail(criterion, `file contains forbidden pattern: ${criterion.pattern}`, { path: full, pattern: criterion.pattern }, undefined, undefined, undefined);
}

export async function validateDirectoryExists(
  criterion: Extract<SuccessCriterion, { kind: "directory_exists" }>,
  baseCwd: string,
): Promise<CriterionResult> {
  const full = resolvePath(criterion.path, baseCwd);
  try {
    const st = await stat(full);
    if (st.isDirectory()) {
      return ok(criterion, `directory exists: ${full}`, { path: full });
    }
    return fail(criterion, `path exists but is not a directory: ${full}`, { path: full }, undefined, undefined, undefined);
  } catch (err) {
    return fail(criterion, `directory not found: ${full}`, { path: full }, undefined, undefined, errMessage(err));
  }
}

export async function validateCommandExitZero(
  criterion: Extract<SuccessCriterion, { kind: "command_exit_zero" }>,
  baseCwd: string,
  timeoutMs = 30_000,
): Promise<CriterionResult> {
  const cwd = criterion.cwd ? resolvePath(criterion.cwd, baseCwd) : baseCwd;
  return await new Promise((resolveP) => {
    // Use bash (not sh): LLM-generated verification commands routinely use
    // bash-only syntax such as process substitution `diff <(...)`, which
    // `/bin/sh` rejects with exit 2 → every step fails forever.
    const child = spawn("/bin/bash", ["-c", criterion.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CriterionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(fail(criterion, `timeout after ${timeoutMs}ms`, { command: criterion.command }, -1, (stdout + stderr).slice(-2000), undefined));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.on("error", (err) => {
      finish(fail(criterion, `spawn error: ${err.message}`, { command: criterion.command }, -1, (stdout + stderr).slice(-2000), undefined));
    });

    child.on("close", (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        finish(okWithExit(criterion, "command exited 0", { command: criterion.command }, exitCode));
      } else {
        finish(fail(criterion, `command exited ${exitCode}`, { command: criterion.command, exitCode }, exitCode, (stdout + stderr).slice(-2000), undefined));
      }
    });
  });
}

export async function validateTestPass(
  criterion: Extract<SuccessCriterion, { kind: "test_pass" }>,
  baseCwd: string,
): Promise<CriterionResult> {
  return await validateCommandExitZero(
    { kind: "command_exit_zero", command: criterion.name, cwd: baseCwd },
    baseCwd,
    120_000,
  );
}

export async function validateGitDiffContains(
  criterion: Extract<SuccessCriterion, { kind: "git_diff_contains" }>,
  baseCwd: string,
): Promise<CriterionResult> {
  const full = resolvePath(".", baseCwd);
  const diff = await new Promise<string>((resolveP) => {
    const child = spawn("git", ["diff", "--no-color"], {
      cwd: full,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (errOut += c.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) resolveP(out);
      else resolveP(`(git diff failed ${code}: ${errOut.slice(-200)})`);
    });
    child.on("error", (err) => resolveP(`(git diff error: ${err.message})`));
  });
  if (diff.includes(criterion.pattern)) {
    return ok(criterion, "git diff contains pattern", { pattern: criterion.pattern });
  }
  return fail(criterion, "git diff does not contain pattern", { pattern: criterion.pattern }, undefined, undefined, undefined);
}

export async function validate(
  criterion: SuccessCriterion,
  baseCwd: string,
): Promise<CriterionResult> {
  switch (criterion.kind) {
    case "file_exists":
      return validateFileExists(criterion, baseCwd);
    case "file_contains":
      return validateFileContains(criterion, baseCwd);
    case "file_not_contains":
      return validateFileNotContains(criterion, baseCwd);
    case "directory_exists":
      return validateDirectoryExists(criterion, baseCwd);
    case "command_exit_zero":
      return validateCommandExitZero(criterion, baseCwd);
    case "test_pass":
      return validateTestPass(criterion, baseCwd);
    case "git_diff_contains":
      return validateGitDiffContains(criterion, baseCwd);
  }
}

function resolvePath(p: string, baseCwd: string): string {
  if (p.startsWith("/")) return p;
  return join(baseCwd, p);
}

function ok(criterion: SuccessCriterion, message: string, metadata: Record<string, unknown>): CriterionResult {
  return { criterion, passed: true, message, exitCode: undefined, output: undefined, metadata };
}

function okWithExit(
  criterion: SuccessCriterion,
  message: string,
  metadata: Record<string, unknown>,
  exitCode: number,
): CriterionResult {
  return { criterion, passed: true, message, exitCode, output: undefined, metadata };
}

function fail(
  criterion: SuccessCriterion,
  message: string,
  metadata: Record<string, unknown>,
  exitCode: number | undefined,
  output: string | undefined,
  detail: string | undefined,
): CriterionResult {
  return {
    criterion,
    passed: false,
    message: detail ? `${message} (${detail})` : message,
    exitCode,
    output,
    metadata,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
