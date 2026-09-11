/**
 * Forge Guard — write journal (pre-change backups).
 *
 * Before an allowed `write`/`edit` tool executes, the guard copies the target
 * file's original content into `<undoRoot>/files/` and appends a JSONL entry
 * to `<undoRoot>/journal.jsonl`. This is the safety premise behind the
 * "file writes are auto-allowed" policy rule: every tool-funneled mutation
 * leaves a byte-exact before-image on disk.
 *
 * This is INTERNAL INSURANCE, not a user-facing undo feature (the Diff/Undo
 * product surface was removed 2026-09-11 — a partial undo that reads as
 * complete is worse than none). Recovery story for users: git. The backups
 * under `<forgeHome>/undo/<sessionId>/` remain manually recoverable.
 *
 * Journaling is best-effort: a failure to journal never blocks the tool.
 */

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type UndoEntry = {
  /** Absolute path of the file that was about to change. */
  path: string;
  /** Absolute path of the backup (null when the file did not exist). */
  backup: string | null;
  action: "modified" | "created";
  at: number;
};

function journalPath(dir: string): string {
  return join(dir, "journal.jsonl");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Back up a file about to be modified/created by a tool call. Returns the
 * journal entry, or null when journaling is disabled (empty `undoRoot`) or
 * failed.
 */
export async function journalFile(
  undoRoot: string,
  cwd: string,
  relPath: string,
): Promise<UndoEntry | null> {
  if (!undoRoot) return null;
  const absolute = resolve(cwd, relPath);
  try {
    await mkdir(join(undoRoot, "files"), { recursive: true });
    const hadOriginal = await exists(absolute);
    let backup: string | null = null;
    if (hadOriginal) {
      backup = join(undoRoot, "files", `${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
      await copyFile(absolute, backup);
    }
    const entry: UndoEntry = {
      path: absolute,
      backup,
      action: hadOriginal ? "modified" : "created",
      at: Date.now(),
    };
    await writeFile(journalPath(undoRoot), JSON.stringify(entry) + "\n", { flag: "a" });
    return entry;
  } catch {
    return null;
  }
}
