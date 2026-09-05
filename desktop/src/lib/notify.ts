/**
 * Task outcome notifications: an in-app toast (always) plus a system
 * notification where the environment allows one. In the Tauri webview the
 * Web Notification API is unavailable, so the plugin API is probed via
 * window.__TAURI_INTERNALS__ and used when present.
 */

export type Toast = { id: number; title: string; body: string; tone: "ok" | "bad" | "info" };

let nextToastId = 1;
let toastSink: ((toast: Toast) => void) | null = null;

/** Register the app-level toast host. */
export function setToastSink(sink: (toast: Toast) => void): void {
  toastSink = sink;
}

function pushToast(title: string, body: string, tone: Toast["tone"]): void {
  toastSink?.({ id: nextToastId++, title, body, tone });
}

export type TaskOutcome = "completed" | "failed" | "cancelled";

export function notifyTaskOutcome(taskId: string, goal: string, outcome: TaskOutcome): void {
  const title = outcome === "completed" ? "Task completed" : outcome === "cancelled" ? "Task cancelled" : "Task failed";
  const body = goal.length > 120 ? goal.slice(0, 120) + "…" : goal;
  pushToast(title, body, outcome === "completed" ? "ok" : outcome === "cancelled" ? "info" : "bad");
  void systemNotify(title, body);
}

async function systemNotify(title: string, body: string): Promise<void> {
  try {
    const w = window as { __TAURI_INTERNALS__?: unknown };
    if (w.__TAURI_INTERNALS__) {
      const plugin = await import("@tauri-apps/plugin-notification");
      let granted = await plugin.isPermissionGranted();
      if (!granted) granted = await plugin.requestPermission() === "granted";
      if (granted) plugin.sendNotification({ title, body });
      return;
    }
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      } else if (Notification.permission === "default") {
        // Browser dev: ask once; takes effect from the next task onward.
        void Notification.requestPermission();
      }
    }
  } catch {
    // Notifications are best-effort; never surface errors for them.
  }
}
