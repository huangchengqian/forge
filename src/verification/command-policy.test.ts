import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideCommand, isReadOnlyVerification } from "./command-policy.ts";

describe("read-only verification allowance", () => {
  const READ_ONLY_CASES = [
    "cat steertest.md",
    "ls -la",
    "ls src",
    "head -5 notes.md",
    "tail -20 log.txt",
    "wc -l report.md",
    "grep -n \"pattern\" src/index.ts",
    "cat a.md | wc -l",
    "cat a.md b.md",
    "test -f output.txt",
    "stat output.txt",
    "file output.bin",
    "du -sh .",
    "diff a.txt b.txt",
  ];

  for (const cmd of READ_ONLY_CASES) {
    test(`readonly: ${cmd}`, () => {
      assert.equal(isReadOnlyVerification(cmd), true);
      const d = decideCommand(cmd);
      assert.equal(d.allowed, true);
      if (d.allowed) assert.equal(d.source, "readonly");
    });
  }

  const NOT_READONLY_CASES = [
    "rm -rf build",                    // mutating binary
    "cat a.md; rm -rf /",              // sequencing escapes
    "echo done > out.txt",             // redirection writes
    "cat /etc/passwd",                 // absolute path reads outside the workspace
    "cat ../../secrets.txt",           // upward path escape
    "find . -delete",                  // find with deletion
    "sort -o out.txt in.txt",          // sort writes via -o (not in the set anyway)
    "node -e 'require(\"fs\")'",       // arbitrary code (also unsafe chars)
    "`cat seed`",                      // command substitution
    "",                                // empty
  ];

  for (const cmd of NOT_READONLY_CASES) {
    test(`not readonly: ${cmd || "(empty)"}`, () => {
      assert.equal(isReadOnlyVerification(cmd), false);
    });
  }

  test("mutating commands still fall through to guard denial", () => {
    const d = decideCommand("rm -rf build");
    assert.equal(d.allowed, false);
  });

  test("registered checks keep their source", () => {
    const d = decideCommand("npm test");
    assert.equal(d.allowed, true);
    if (d.allowed) assert.equal(d.source, "registered");
  });
});
