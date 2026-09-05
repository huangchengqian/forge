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
  | "TASK_CANCELLED"
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

/**
 * Per-task FIFO chain for appends.
 *
 * The streaming path fires appends without awaiting them (`void appendEvent`
 * in task-manager's onPiEvent, one call per agent delta). Concurrent
 * appendFile calls race in the libuv threadpool and their writes land in
 * arbitrary order, scrambling the JSONL line order. The SSE stream and the
 * desktop treat this file as ordered truth, so scrambled appends corrupted
 * streamed text (observed as CJK delta reordering / swapped chunks in real
 * captures). Chaining per task restores call-order persistence; await
 * semantics are unchanged — a caller's append still completes before its
 * promise resolves.
 */
const appendQueues = new Map<string, Promise<unknown>>();

export function appendEvent(taskId: string, type: PersistedEventType, payload: Record<string, unknown>): Promise<PersistedEvent> {
  const prev = appendQueues.get(taskId) ?? Promise.resolve();
  const run = prev.then(() => appendEventNow(taskId, type, payload));
  // Keep the chain alive (and the map bounded) even if an append fails.
  const queued = run.catch(() => {});
  appendQueues.set(taskId, queued);
  void queued.finally(() => {
    if (appendQueues.get(taskId) === queued) appendQueues.delete(taskId);
  });
  return run;
}

async function appendEventNow(taskId: string, type: PersistedEventType, payload: Record<string, unknown>): Promise<PersistedEvent> {
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
