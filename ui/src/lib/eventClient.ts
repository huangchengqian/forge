import type {
  ForgeEvent,
  MemoryItem,
  TaskSession,
} from "../shared/types.ts";

export type UiSnapshot = {
  task: TaskSession | null;
  memory: readonly MemoryItem[];
};

export type UiMessage =
  | { kind: "snapshot"; payload: UiSnapshot }
  | { kind: "event"; payload: ForgeEvent };

export type UiState = {
  task: TaskSession | null;
  events: readonly ForgeEvent[];
  memory: readonly MemoryItem[];
};

export type UiStore = {
  state: UiState;
  subscribe: (listener: () => void) => () => void;
  start: (url: string) => () => void;
};

export function createUiStore(): UiStore {
  let state: UiState = { task: null, events: [], memory: [] };
  const listeners = new Set<() => void>();

  const emit = (next: UiState) => {
    state = next;
    for (const l of listeners) l();
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(url: string) {
      const base = url.endsWith("/") ? url : `${url}/`;
      const es = new EventSource(`${base}events`);
      es.onmessage = (ev: MessageEvent<string>) => {
        let msg: UiMessage | null = null;
        try {
          msg = JSON.parse(ev.data) as UiMessage;
        } catch {
          return;
        }
        if (msg.kind === "snapshot") {
          emit({ ...state, task: msg.payload.task, memory: msg.payload.memory });
          return;
        }
        if (msg.kind === "event") {
          const updatedTask = applyEvent(state.task, msg.payload);
          emit({
            task: updatedTask,
            memory: state.memory,
            events: [...state.events, msg.payload],
          });
        }
      };
      es.onerror = () => {};
      return () => es.close();
    },
  };
}

function applyEvent(task: TaskSession | null, event: ForgeEvent): TaskSession | null {
  if (!task || task.id !== event.taskId) return task;
  switch (event.type) {
    case "state_changed":
      return { ...task, state: event.to, updatedAt: event.at };
    case "completed":
      return { ...task, state: "COMPLETE", updatedAt: event.at };
    case "failed":
      return { ...task, state: "FAILED", failureReason: event.reason, updatedAt: event.at };
    default:
      return task;
  }
}

