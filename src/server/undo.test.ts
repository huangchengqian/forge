import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { captureGitHead, computeDiff, restoreUndo } from "./undo.ts";
import { journalFile, readJournal } from "../guard/journal.ts";

const TMP = "/tmp/forge-undo-tests";
const FORGE_HOME = join(TMP, "home");
const TASK = "undo-task-1";
const WS = join(TMP, "ws");

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  mkdirSync(join(FORGE_HOME), { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("undo journal (non-git)", () => {
  test("journalFile + computeDiff + restoreUndo round-trip", async () => {
    process.env.FORGE_UNDO_DIR = join(FORGE_HOME, "undo", TASK);
    try {
      const target = join(WS, "src", "a.ts");
      mkdirSync(join(WS, "src"), { recursive: true });
      writeFileSync(target, "original\n", "utf8");

      // Simulate the guard journaling a modification + a creation.
      const mod = await journalFile(WS, "src/a.ts");
      assert.ok(mod);
      assert.equal(mod.action, "modified");
      assert.ok(mod.backup && existsSync(mod.backup));
      writeFileSync(target, "changed\n", "utf8"); // tool writes after journal

      const created = await journalFile(WS, "newfile.txt");
      assert.ok(created);
      assert.equal(created.action, "created");
      assert.equal(created.backup, null);
      writeFileSync(join(WS, "newfile.txt"), "hi\n", "utf8");

      const entries = await readJournal(join(FORGE_HOME, "undo", TASK));
      assert.equal(entries.length, 2);

      const diff = await computeDiff(FORGE_HOME, TASK, WS);
      assert.equal(diff.kind, "journal");
      if (diff.kind === "journal") {
        assert.equal(diff.files.length, 2);
        const a = diff.files.find((f) => f.path === target);
        assert.ok(a);
        assert.equal(a.backup, true);
      }

      const undo = await restoreUndo(FORGE_HOME, TASK);
      assert.equal(undo.restored, 2);
      assert.equal(readFileSync(target, "utf8"), "original\n");
      assert.equal(existsSync(join(WS, "newfile.txt")), false);
    } finally {
      delete process.env.FORGE_UNDO_DIR;
    }
  });
});

describe("git diff baseline", () => {
  test("captureGitHead + computeDiff returns git diff since task start", async () => {
    // Build a real repo with one commit.
    execFileSync("git", ["init", "-b", "main", WS], { stdio: "ignore" });
    execFileSync("git", ["-C", WS, "config", "user.email", "test@forge"], { stdio: "ignore" });
    execFileSync("git", ["-C", WS, "config", "user.name", "Forge Test"], { stdio: "ignore" });
    writeFileSync(join(WS, "a.txt"), "v1\n", "utf8");
    execFileSync("git", ["-C", WS, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", WS, "commit", "-m", "init"], { stdio: "ignore" });

    await captureGitHead(FORGE_HOME, TASK, WS);
    // Agent modifies after baseline.
    writeFileSync(join(WS, "a.txt"), "v2\n", "utf8");

    const diff = await computeDiff(FORGE_HOME, TASK, WS);
    assert.equal(diff.kind, "git");
    if (diff.kind === "git") {
      assert.ok(diff.head.length === 40, "head is a sha");
      assert.match(diff.diff, /a\.txt/);
      assert.match(diff.diff, /v2/);
      assert.match(diff.status, /a\.txt/);
    }
  });
});
