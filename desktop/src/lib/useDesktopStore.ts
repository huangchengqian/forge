import { useEffect, useState, useRef } from "react";
import { streamUrl, fetchTaskList, fetchMemory, createTask, sendMessage, deleteSession as deleteSessionApi } from "./desktop-client.ts";
import type { EventEnvelope } from "./desktop-client.ts";
import type { TaskSession, MemoryItem } from "../shared/types.ts";

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
    state = { ...state, selectedTaskId: id, liveEvents: [] };
    emit();
    if (id) {
      // The SSE endpoint replays full history then follows appends, so a fresh
      // connection gives us the complete event sequence for this session.
      const es = new EventSource(streamUrl(id));
      es.onmessage = (ev) => {
        try {
          const env = JSON.parse(ev.data) as EventEnvelope;
          state = { ...state, liveEvents: [...state.liveEvents, env] };
          if (["TASK_COMPLETED", "TASK_FAILED"].includes(env.type)) {
            setTimeout(refresh, 200);
          }
        } catch {}
        emit();
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
    connectStream(taskId: string): () => void {
      const es = new EventSource(streamUrl(taskId));
      es.onmessage = (ev) => {
        try {
          const env = JSON.parse(ev.data) as EventEnvelope;
          state = { ...state, liveEvents: [...state.liveEvents, env] };
          if (["TASK_COMPLETED", "TASK_FAILED"].includes(env.type)) {
            setTimeout(refresh, 200);
          }
        } catch {}
        emit();
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
