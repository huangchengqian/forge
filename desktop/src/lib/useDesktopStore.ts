import { useEffect, useState, useRef } from "react";
import { streamUrl, fetchTaskList, fetchMemory, createTask, sendMessage, deleteSession as deleteSessionApi, renameTask } from "./desktop-client.ts";
import type { EventEnvelope } from "./desktop-client.ts";
import type { TaskSession, MemoryItem } from "../shared/types.ts";
import { notifyTaskOutcome } from "./notify.ts";

export type DesktopState = {
  tasks: readonly TaskSession[];
  memory: readonly MemoryItem[];
  liveEvents: readonly EventEnvelope[];
  selectedTaskId: string | null;
};

let singleton: ReturnType<typeof createStore> | null = null;

function createStore() {
  let state: DesktopState = { tasks: [], memory: [], liveEvents: [], selectedTaskId: null };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  let closeStream: (() => void) | null = null;

  // Streaming deltas arrive one SSE event at a time; applying each
  // individually re-renders (and re-parses markdown) far more often than the
  // eye can notice. Buffer incoming envelopes and flush every ~50ms so a
  // burst of deltas costs one render instead of dozens.
  const FLUSH_INTERVAL_MS = 50;
  let pendingEvents: Array<{ env: EventEnvelope; taskId: string }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPending() {
    flushTimer = null;
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents;
    pendingEvents = [];
    state = { ...state, liveEvents: [...state.liveEvents, ...batch.map((b) => b.env)] };
    for (const { env, taskId } of batch) {
      if (env.type === "TASK_COMPLETED" || env.type === "TASK_FAILED" || env.type === "TASK_CANCELLED") {
        const goal = state.tasks.find((t) => t.id === taskId)?.goal ?? "";
        notifyTaskOutcome(taskId, goal, env.type === "TASK_COMPLETED" ? "completed" : env.type === "TASK_CANCELLED" ? "cancelled" : "failed");
      }
    }
    if (batch.some((b) => ["TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED"].includes(b.env.type))) {
      setTimeout(refresh, 200);
    }
    emit();
  }

  function enqueueEvent(env: EventEnvelope, taskId: string) {
    pendingEvents.push({ env, taskId });
    if (!flushTimer) {
      flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
    }
  }

  function clearPending() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pendingEvents = [];
  }

  function refresh() {
    void Promise.all([fetchTaskList(), fetchMemory()]).then(([tasks, memory]) => {
      state = { ...state, tasks, memory };
      emit();
    });
  }

  async function createTaskAction(input: { goal: string; provider?: string; modelId?: string; providerId?: string; maxConcurrency?: number }): Promise<string> {
    const { taskId } = await createTask(input);
    refresh();
    return taskId;
  }

  /** Open (or close) the live event stream for the selected session. */
  function select(id: string) {
    if (closeStream) { closeStream(); closeStream = null; }
    clearPending();
    state = { ...state, selectedTaskId: id, liveEvents: [] };
    emit();
    if (id) {
      // The SSE endpoint replays full history then follows appends, so a fresh
      // connection gives us the complete event sequence for this session.
      const es = new EventSource(streamUrl(id));
      es.onmessage = (ev) => {
        try {
          enqueueEvent(JSON.parse(ev.data) as EventEnvelope, id);
        } catch {}
      };
      closeStream = () => es.close();
    }
  }

  return {
    get state() {
      return state;
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    select,
    async refreshTasks() {
      refresh();
    },
    async createTask(input: { goal: string; provider?: string; modelId?: string; providerId?: string; maxConcurrency?: number }) {
      return createTaskAction(input);
    },
    async sendMessage(taskId: string, message: string) {
      await sendMessage(taskId, message);
    },
    async deleteSession(taskId: string) {
      await deleteSessionApi(taskId);
      if (state.selectedTaskId === taskId) {
        if (closeStream) { closeStream(); closeStream = null; }
        state = { ...state, selectedTaskId: null, liveEvents: [] };
      }
      refresh();
    },
    async renameSession(taskId: string, goal: string) {
      await renameTask(taskId, goal);
      refresh();
    },
    connectStream(taskId: string): () => void {
      const es = new EventSource(streamUrl(taskId));
      es.onmessage = (ev) => {
        try {
          enqueueEvent(JSON.parse(ev.data) as EventEnvelope, taskId);
        } catch {}
      };
      return () => es.close();
    },
  };
}

export function useDesktop() {
  const storeRef = useRef(singleton);
  if (!storeRef.current) singleton = storeRef.current = createStore();
  const [, force] = useState(0);
  useEffect(() => singleton!.subscribe(() => force((n) => n + 1)), []);
  return singleton!;
}
