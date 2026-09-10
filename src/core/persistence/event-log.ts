import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../../events/event-bus.ts";
import { defaultBus } from "../../events/event-bus.ts";
import type { ControlEvent, ControlEventType } from "../../events/event-types.ts";

export function eventsDir(): string {
  return resolve(
    process.env.FORGE_EVENTS_DIR ?? join(process.env.HOME ?? "/tmp", ".forge", "events"),
  );
}

export type PersistedEventType =
  // lifecycle
  | "SESSION_CREATED"
  | "SESSION_STARTED"
  | "SESSION_RESUMED"
  | "SESSION_ENDED"
  | "SESSION_FAILED"
  | "SESSION_CANCELLED"
  // agent loop (data plane — high frequency, not fanned out to the bus)
  // AGENT_RUN_* is the Pi-run lifecycle (one runAgent call), distinct from
  // the SESSION_* lifecycle (the session as a whole, owned by SessionManager).
  // A resumed session legitimately logs SESSION_* once + AGENT_RUN_* per run.
  | "AGENT_RUN_STARTED"
  | "AGENT_RUN_ENDED"
  // mid-session model switch (POST /sessions/:id/model)
  | "MODEL_CHANGED"
  // mid-session completion-verification switch (POST /sessions/:id/trust).
  // Same plane as MODEL_CHANGED: an operator action, not a loop signal — the
  // UI reads it from the log over SSE, so it stays out of the control bus.
  | "TRUST_CHANGED"
  | "TURN_STARTED"
  | "TURN_ENDED"
  | "MESSAGE_STARTED"
  | "MESSAGE_UPDATED"
  | "MESSAGE_ENDED"
  | "TEXT_DELTA"
  | "TOOL_CALL"
  | "TOOL_UPDATE"
  | "TOOL_RESULT"
  // guardrails (Phase 3+; reserved so event types cover everything the UI renders)
  | "STEERING_QUEUED"
  | "VERIFICATION_RESULT"
  | "COST_UPDATE"
  | "STUCK_WARNING"
  // Phase 3: tool-policy boundaries (added with the EventBus collapse — see
  // docs/25 §6.2 phase 1). Payload shape:
  //   GUARD_BLOCKED            → { toolName: string, reason: string }
  //   GUARD_APPROVAL_REQUEST   → { requestId: string, toolName: string }
  | "GUARD_BLOCKED"
  | "GUARD_APPROVAL_REQUEST"
  // Phase 3: trust-level-high evaluator round. Payload shape:
  //   EVALUATION_COMPLETED     → EvaluationResult ({ taskId, score, status, findings, evidence })
  | "EVALUATION_COMPLETED"
  // Phase 5: compaction
  | "COMPACTION"
  | "COMPACTION_FAILED";

export type PersistedEvent = {
  id: string;
  type: PersistedEventType;
  taskId: string;
  at: number;
  payload: Record<string, unknown>;
};

/**
 * Control-plane subset of PersistedEventType. These are the events that
 * `appendEvent` fans out to the in-process EventBus after writing to disk.
 * Data-plane events (TURN, MESSAGE, TEXT_DELTA, TOOL families) stay in the
 * log only — high volume, not actionable as notifications.
 */
const CONTROL_EVENT_TYPES: ReadonlySet<PersistedEventType> = new Set<PersistedEventType>([
  "SESSION_CREATED",
  "SESSION_STARTED",
  "SESSION_RESUMED",
  "SESSION_ENDED",
  "SESSION_FAILED",
  "SESSION_CANCELLED",
  "STEERING_QUEUED",
  "VERIFICATION_RESULT",
  "COST_UPDATE",
  "STUCK_WARNING",
  "GUARD_BLOCKED",
  "GUARD_APPROVAL_REQUEST",
  "EVALUATION_COMPLETED",
  "COMPACTION",
  "COMPACTION_FAILED",
]);

export function isControlEvent(type: PersistedEventType): type is ControlEventType {
  return CONTROL_EVENT_TYPES.has(type);
}

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

/**
 * Append a control- or data-plane event to the task's JSONL log, then
 * fan out to the control-plane bus if applicable. The bus is a pure
 * fan-out of the persisted event — same id, same type, same payload, same
 * timestamp. Subscribers receive the exact event that lives in the log.
 *
 * Fan-out failures are isolated: a throwing listener does not affect the
 * append result or the FIFO chain.
 */
export function appendEvent(
  taskId: string,
  type: PersistedEventType,
  payload: Record<string, unknown>,
  opts?: { bus?: EventBus },
): Promise<PersistedEvent> {
  const bus = opts?.bus ?? defaultBus;
  const prev = appendQueues.get(taskId) ?? Promise.resolve();
  const run = prev.then(() => appendEventNow(taskId, type, payload, bus));
  // Keep the chain alive (and the map bounded) even if an append fails.
  const queued = run.catch(() => {});
  appendQueues.set(taskId, queued);
  void queued.finally(() => {
    if (appendQueues.get(taskId) === queued) appendQueues.delete(taskId);
  });
  return run;
}

async function appendEventNow(
  taskId: string,
  type: PersistedEventType,
  payload: Record<string, unknown>,
  bus: EventBus,
): Promise<PersistedEvent> {
  await mkdir(eventsDir(), { recursive: true });
  const event: PersistedEvent = {
    id: randomUUID(),
    type,
    taskId,
    at: Date.now(),
    payload,
  };
  await appendFile(eventFile(taskId), JSON.stringify(event) + "\n", "utf8");

  // Fan out to the control-plane bus (data-plane events stop at the log).
  // Bus publish errors are caught inside EventBus.publish — they cannot
  // break the append chain.
  if (isControlEvent(type)) {
    bus.publish(event as ControlEvent);
  }

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