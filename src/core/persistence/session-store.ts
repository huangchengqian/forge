import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Session } from "../../types.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json.ts";
import { stampSchemaVersion, migrateSession } from "./schema.ts";

export const SESSIONS_DIR = resolve(
  process.env.FORGE_SESSIONS_DIR ??
    join(process.env.HOME ?? "/tmp", ".forge", "sessions"),
);

export async function saveSession(session: Session): Promise<void> {
  await writeJsonFileAtomic(
    join(SESSIONS_DIR, `${session.id}.json`),
    stampSchemaVersion(session as unknown as Record<string, unknown>) as unknown as Session,
  );
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const raw = await readJsonFile<Record<string, unknown>>(
      join(SESSIONS_DIR, `${id}.json`),
    );
    return migrateSession(raw) as unknown as Session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const entries = await readdir(SESSIONS_DIR);
    const out: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readJsonFile<Record<string, unknown>>(join(SESSIONS_DIR, entry));
        out.push(migrateSession(raw) as unknown as Session);
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<void> {
  await rm(join(SESSIONS_DIR, `${id}.json`), { force: true });
}
