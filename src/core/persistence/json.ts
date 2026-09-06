import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export const TASKS_DIR = resolve(
  process.env.FORGE_TASKS_DIR ?? join(process.env.HOME ?? "/tmp", ".forge", "tasks"),
);

export async function readJsonFile<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as T;
}

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // UUID suffix: pid+ms collides when two saves race in the same
  // millisecond (orchestrator save vs a control-plane save), and the first
  // rename would consume the second's tmp file (ENOENT, task file lost).
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

export function taskPath(id: string): string {
  return join(TASKS_DIR, `${id}.json`);
}
