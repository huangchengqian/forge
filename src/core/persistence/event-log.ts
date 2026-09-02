import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function eventsDir(): string {
  return resolve(
    process.env.FORGE_EVENTS_DIR ?? join(process.env.HOME ?? "/tmp", ".forge", "events"),
  );
}

export type PersistedEventType =
  | "TASK_CREATED"
  | "STATE_CHANGED"
  | "STEP_STARTED"
  | "OBSERVATION_CREATED"
  | "FIX_STARTED"
  | "PLAN_CREATED"
  | "STEP_ADDED"
  | "STEP_UPDATED"
  | "PLAN_REVISED"
  | "EVALUATION_STARTED"
  | "EVALUATION_COMPLETED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "MEMORY_USED"
  | "AGENT_EVENT";

export type PersistedEvent = {
  id: string;
  type: PersistedEventType;
  taskId: string;
  at: number;
  payload: Record<string, unknown>;
};

function eventFile(taskId: string): string {
  return join(eventsDir(), `${taskId}.events.jsonl`);
}

export async function appendEvent(taskId: string, type: PersistedEventType, payload: Record<string, unknown>): Promise<PersistedEvent> {
  await mkdir(eventsDir(), { recursive: true });
  const event: PersistedEvent = {
    id: randomUUID(),
    type,
    taskId,
    at: Date.now(),
    payload,
  };
  await appendFile(eventFile(taskId), JSON.stringify(event) + "\n", "utf8");
  return event;
}

export async function readEvents(taskId: string): Promise<readonly PersistedEvent[]> {
  try {
    const text = await readFile(eventFile(taskId), "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as PersistedEvent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
