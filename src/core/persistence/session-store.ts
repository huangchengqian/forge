import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Session } from "../../types.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json.ts";
import { stampSchemaVersion, migrateSession } from "./schema.ts";

/** Resolved per call, not at module load — test/smoke harnesses set
 * FORGE_SESSIONS_DIR *after* this module is imported, and an eager const
 * would silently freeze the real ~/.forge path (dumping fixtures into the
 * developer's home). Mirrors event-log.ts's eventsDir(). */
export function sessionsDir(): string {
  return resolve(
    process.env.FORGE_SESSIONS_DIR ??
      join(process.env.HOME ?? "/tmp", ".forge", "sessions"),
  );
}

export async function saveSession(session: Session): Promise<void> {
  await writeJsonFileAtomic(
    join(sessionsDir(), `${session.id}.json`),
    stampSchemaVersion(session as unknown as Record<string, unknown>) as unknown as Session,
  );
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const raw = await readJsonFile<Record<string, unknown>>(
      join(sessionsDir(), `${id}.json`),
    );
    return migrateSession(raw) as unknown as Session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir);
    const out: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readJsonFile<Record<string, unknown>>(join(dir, entry));
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
  await rm(join(sessionsDir(), `${id}.json`), { force: true });
}
