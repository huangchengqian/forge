import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  validate,
  verifyCriteria,
} from "../verification/index.ts";
import { validateCommandExitZero } from "../verification/validate.ts";
import type { SuccessCriterion } from "../core/types/criterion.ts";

const TMP = "/tmp/forge-verify-tests";

before(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("file_exists", () => {
  test("pass when file exists", async () => {
    const p = join(TMP, "exists.ts");
    await writeFile(p, "x\n", "utf8");
    const r = await validate({ kind: "file_exists", path: "exists.ts" }, TMP);
    assert.equal(r.passed, true);
    assert.ok(r.metadata?.path);
  });

  test("fail when file missing", async () => {
    const r = await validate({ kind: "file_exists", path: "missing.ts" }, TMP);
    assert.equal(r.passed, false);
  });
});

describe("file_contains", () => {
  test("pass when pattern present", async () => {
    const p = join(TMP, "contains.ts");
    await writeFile(p, 'export const x = "hello world";\n', "utf8");
    const r = await validate({ kind: "file_contains", path: "contains.ts", pattern: "hello world" }, TMP);
    assert.equal(r.passed, true);
  });

  test("fail when pattern absent", async () => {
    const p = join(TMP, "absent.ts");
    await writeFile(p, "no pattern here\n", "utf8");
    const r = await validate({ kind: "file_contains", path: "absent.ts", pattern: "zzz" }, TMP);
    assert.equal(r.passed, false);
  });
});

describe("file_not_contains", () => {
  test("pass when forbidden pattern absent", async () => {
    const p = join(TMP, "clean.ts");
    await writeFile(p, "safe code\n", "utf8");
    const r = await validate({ kind: "file_not_contains", path: "clean.ts", pattern: "TODO" }, TMP);
    assert.equal(r.passed, true);
  });

  test("fail when forbidden pattern present", async () => {
    const p = join(TMP, "dirty.ts");
    await writeFile(p, "// TODO: fix this\n", "utf8");
    const r = await validate({ kind: "file_not_contains", path: "dirty.ts", pattern: "TODO" }, TMP);
    assert.equal(r.passed, false);
  });
});

describe("directory_exists", () => {
  test("pass when dir exists", async () => {
    await mkdir(join(TMP, "subdir"), { recursive: true });
    const r = await validate({ kind: "directory_exists", path: "subdir" }, TMP);
    assert.equal(r.passed, true);
  });

  test("fail when dir missing", async () => {
    const r = await validate({ kind: "directory_exists", path: "nodir" }, TMP);
    assert.equal(r.passed, false);
  });
});

describe("command_exit_zero", () => {
  test("runs a registered project check", async () => {
    await writeFile(join(TMP, "pass.test.mjs"), 'import test from "node:test"; test("pass", () => {});\n', "utf8");
    const r = await validateCommandExitZero({ kind: "command_exit_zero", command: "node --test pass.test.mjs" }, TMP);
    assert.equal(r.passed, true);
    assert.equal(r.exitCode, 0);
  });

  test("blocks custom shell commands unless Guard explicitly allows them", async () => {
    const r = await validateCommandExitZero({ kind: "command_exit_zero", command: "exit 3" }, TMP);
    assert.equal(r.passed, false);
    assert.match(r.message, /requires an explicit Forge Guard allow rule/);
  });

  test("rejects an absolute or escaping cwd", async () => {
    const absolute = await validateCommandExitZero({ kind: "command_exit_zero", command: "node --test pass.test.mjs", cwd: "/tmp" }, TMP);
    const escape = await validateCommandExitZero({ kind: "command_exit_zero", command: "node --test pass.test.mjs", cwd: "../" }, TMP);
    assert.equal(absolute.passed, false);
    assert.equal(escape.passed, false);
  });
});

describe("git_diff_contains", () => {
  test("handles non-git dir gracefully", async () => {
    const r = await validate({ kind: "git_diff_contains", pattern: "anything" }, TMP);
    assert.equal(typeof r.passed, "boolean");
  });
});

describe("test_pass", () => {
  test("passes when test command exits 0", async () => {
    await writeFile(join(TMP, "pass-command.test.mjs"), 'import test from "node:test"; test("pass", () => {});\n', "utf8");
    const r = await validate({ kind: "test_pass", name: "node --test pass-command.test.mjs" }, TMP);
    assert.equal(r.passed, true);
  });

  test("fails when test command exits non-zero", async () => {
    const r = await validate({ kind: "test_pass", name: "exit 1" }, TMP);
    assert.equal(r.passed, false);
  });
});

describe("workspace confinement", () => {
  test("rejects file criteria that escape the workspace", async () => {
    const r = await validate({ kind: "file_exists", path: "../outside.txt" }, TMP);
    assert.equal(r.passed, false);
    assert.match(r.message, /escapes the task workspace/);
  });
});

describe("verifyCriteria (multiple criteria)", () => {
  test("pass when all criteria pass", async () => {
    await writeFile(join(TMP, "multi.ts"), 'const y = "hello world";\n', "utf8");
    const criteria = [
      { kind: "file_exists", path: "multi.ts" },
      { kind: "file_contains", path: "multi.ts", pattern: "hello world" },
      { kind: "file_not_contains", path: "multi.ts", pattern: "forbidden" },
    ] as SuccessCriterion[];
    const v = await verifyCriteria("step-1", criteria, TMP);
    assert.equal(v.passed, true);
    assert.equal(v.failed.length, 0);
    assert.equal(v.criteriaResults.length, 3);
    assert.equal(v.metadata.total, 3);
    assert.equal(v.metadata.failedCount, 0);
  });

  test("fail when any criterion fails", async () => {
    await writeFile(join(TMP, "multi2.ts"), 'const z = "nope";\n', "utf8");
    const criteria = [
      { kind: "file_exists", path: "multi2.ts" },
      { kind: "file_contains", path: "multi2.ts", pattern: "hello world" },
      { kind: "file_not_contains", path: "multi2.ts", pattern: "nope" },
    ] as SuccessCriterion[];
    const v = await verifyCriteria("step-1", criteria, TMP);
    assert.equal(v.passed, false);
    assert.equal(v.failed.length, 2);
    assert.equal(v.reasons.length, 2);
    assert.equal(v.metadata.failedCount, 2);
  });
});

describe("retry compatibility", () => {
  test("verifyCriteria is callable multiple times (idempotent per invocation)", async () => {
    await writeFile(join(TMP, "retry.ts"), "x\n", "utf8");
    const criteria = [{ kind: "file_exists", path: "retry.ts" }] as SuccessCriterion[];
    const v1 = await verifyCriteria("step-1", criteria, TMP);
    const v2 = await verifyCriteria("step-1", criteria, TMP);
    assert.equal(v1.passed, true);
    assert.equal(v2.passed, true);
  });
});
