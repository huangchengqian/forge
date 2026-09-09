import type { ControlEvent, ControlEventListener } from "./event-types.ts";

/**
 * In-process pub/sub for control-plane events. The bus is a fan-out target
 * from the append-only event log: `appendEvent` publishes control-plane
 * events here after writing them to disk. Subscribers (cross-guardrail
 * coordination, analytics, watchdog) receive the same event object that
 * went into the log.
 *
 * The bus has zero coupling to SSE/HTTP — the desktop UI reads the event
 * log directly. This bus is intentionally in-process only.
 */
export class EventBus {
  private listeners = new Set<ControlEventListener>();

  subscribe(listener: ControlEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ControlEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A failing listener must not break the append chain.
        console.error("[forge] event listener threw:", err);
      }
    }
  }
}

/**
 * Process-wide default for `appendEvent` fan-out. Tests can inject a
 * different bus per-call via `appendEvent(taskId, type, payload, { bus })`
 * to observe/control fan-out without polluting the global bus.
 */
export const defaultBus = new EventBus();