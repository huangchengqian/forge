import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TaskSession } from "../types/task-session.ts";
import { readJsonFile, taskPath, TASKS_DIR, writeJsonFileAtomic } from "./json.ts";
import { stampSchemaVersion, migrateTask } from "./schema.ts";

export async function saveTask(task: TaskSession): Promise<void> {
  await writeJsonFileAtomic(taskPath(task.id), stampSchemaVersion(task as unknown as Record<string, unknown>) as unknown as TaskSession);
}

export async function loadTask(id: string): Promise<TaskSession | null> {
  try {
    const raw = await readJsonFile<Record<string, unknown>>(taskPath(id));
    return migrateTask(raw) as unknown as TaskSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listTasks(): Promise<TaskSession[]> {
  try {
    await mkdir(TASKS_DIR, { recursive: true });
    const entries = await readdir(TASKS_DIR);
    const out: TaskSession[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readJsonFile<Record<string, unknown>>(join(TASKS_DIR, entry));
        out.push(migrateTask(raw) as unknown as TaskSession);
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function deleteTask(id: string): Promise<void> {
  await rm(taskPath(id), { force: true });
}

export async function taskExists(id: string): Promise<boolean> {
  try {
    await stat(taskPath(id));
    return true;
  } catch {
    return false;
  }
}
