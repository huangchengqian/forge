/**
 * Undo / Diff surface (9.6.6).
 *
 * - `git` workspaces: diff against the commit captured at task start
 *   (`<forgeHome>/undo/<taskId>/git-head`); undo restores journal backups.
 * - non-git workspaces: diff is the journal change list (before-images only);
 *   undo restores those backups.
 *
 * Journal files are written by the guard extension (inside the Pi subprocess)
 * under `<forgeHome>/undo/<taskId>/`. git-head is captured server-side at task
 * creation, BEFORE the agent runs.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearJournal, readJournal, restoreEntry, type UndoEntry } from "../guard/journal.ts";

export type DiffResult =
  | {
      kind: "git";
      head: string;
      diff: string;
      status: string;
    }
  | {
      kind: "journal";
      files: Array<{
        path: string;
        backup: boolean;
        action: UndoEntry["action"];
        size: number;
        exists: boolean;
      }>;
    }
  | { kind: "none"; reason: string };

function undoDir(forgeHome: string, taskId: string): string {
  return join(forgeHome, "undo", taskId);
}

function gitHeadPath(forgeHome: string, taskId: string): string {
  return join(undoDir(forgeHome, taskId), "git-head");
}

/** Capture the workspace git HEAD before the agent runs (best-effort). */
export async function captureGitHead(forgeHome: string, taskId: string, workspace: string): Promise<void> {
  try {
    const head = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!head) return;
    await mkdir(undoDir(forgeHome, taskId), { recursive: true });
    await writeFile(gitHeadPath(forgeHome, taskId), head, "utf8");
  } catch {
    // not a git repo — journal-only mode
  }
}

async function readGitHead(forgeHome: string, taskId: string): Promise<string | null> {
  try {
    return (await readFile(gitHeadPath(forgeHome, taskId), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function git(args: string[], workspace: string): string {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export async function computeDiff(forgeHome: string, taskId: string, workspace: string): Promise<DiffResult> {
  const head = await readGitHead(forgeHome, taskId);
  if (head) {
    try {
      const diff = git(["diff", head, "--", "."], workspace);
      const status = git(["status", "--short"], workspace);
      return { kind: "git", head, diff, status };
    } catch (err) {
      return { kind: "none", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const entries = await readJournal(undoDir(forgeHome, taskId));
  if (entries.length === 0) return { kind: "none", reason: "no tracked changes" };

  const files = await Promise.all(
    entries.map(async (e) => {
      let size = 0;
      let exists = false;
      try {
        const st = await stat(e.path);
        exists = st.isFile();
        size = st.size;
      } catch {}
      return { path: e.path, backup: !!e.backup, action: e.action, size, exists };
    }),
  );
  return { kind: "journal", files };
}

export async function restoreUndo(forgeHome: string, taskId: string): Promise<{ restored: number; files: string[] }> {
  const dir = undoDir(forgeHome, taskId);
  const entries = await readJournal(dir);
  const files: string[] = [];
  let restored = 0;
  for (const e of entries) {
    if (await restoreEntry(e)) {
      restored++;
      files.push(e.path);
    }
  }
  await clearJournal(dir);
  return { restored, files };
}
