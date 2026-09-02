/**
 * Forge Guard — undo journal (9.6.6, git-independent rollback).
 *
 * Before an allowed `write`/`edit` tool executes, the guard copies the target
 * file's original content into `$FORGE_UNDO_DIR/files/` and appends a JSONL
 * entry to `$FORGE_UNDO_DIR/journal.jsonl`. The Forge server reads this
 * journal to render diffs and to restore the pre-task state (POST undo).
 *
 * Journaling is best-effort: a failure to journal never blocks the tool.
 */

import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type UndoEntry = {
  /** Absolute path of the file that was about to change. */
  path: string;
  /** Absolute path of the backup (null when the file did not exist). */
  backup: string | null;
  action: "modified" | "created";
  at: number;
};

export function undoDir(): string | null {
  return process.env.FORGE_UNDO_DIR ?? null;
}

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
 * journal entry, or null when journaling is disabled or failed.
 */
export async function journalFile(cwd: string, relPath: string): Promise<UndoEntry | null> {
  const dir = undoDir();
  if (!dir) return null;
  const absolute = resolve(cwd, relPath);
  try {
    await mkdir(join(dir, "files"), { recursive: true });
    const hadOriginal = await exists(absolute);
    let backup: string | null = null;
    if (hadOriginal) {
      backup = join(dir, "files", `${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
      await copyFile(absolute, backup);
    }
    const entry: UndoEntry = {
      path: absolute,
      backup,
      action: hadOriginal ? "modified" : "created",
      at: Date.now(),
    };
    await appendJournalEntry(dir, entry);
    return entry;
  } catch {
    return null;
  }
}

async function appendJournalEntry(dir: string, entry: UndoEntry): Promise<void> {
  await writeFile(journalPath(dir), JSON.stringify(entry) + "\n", { flag: "a" });
}

/** Read all journal entries for a task (server side). */
export async function readJournal(dir: string): Promise<readonly UndoEntry[]> {
  try {
    const raw = await readFile(journalPath(dir), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as UndoEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is UndoEntry => !!e && typeof e.path === "string");
  } catch {
    return [];
  }
}

/** Remove the journal + backups for a task. */
export async function clearJournal(dir: string): Promise<void> {
  try {
    await unlink(journalPath(dir));
  } catch {}
  try {
    await rename(dir, `${dir}.consumed-${Date.now()}`);
  } catch {}
}

/** Move a backup back over its original path (or delete a created file). */
export async function restoreEntry(entry: UndoEntry): Promise<boolean> {
  try {
    if (entry.backup) {
      await mkdir(dirname(entry.path), { recursive: true });
      await copyFile(entry.backup, entry.path);
      return true;
    }
    // Created file (no backup): undo = delete the file if it still exists.
    await unlink(entry.path).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
