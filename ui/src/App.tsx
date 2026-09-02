import { useEffect } from "react";
import { TaskHeader } from "./components/TaskHeader.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { TimelineView } from "./components/TimelineView.tsx";
import { VerificationPanel } from "./components/VerificationPanel.tsx";
import { MemoryPanel } from "./components/MemoryPanel.tsx";
import { RuntimeDetail } from "./components/RuntimeDetail.tsx";
import { useUiStore } from "./lib/useUiStore.ts";

const FORGE_BACKEND = (globalThis as { FORGE_BACKEND_URL?: string }).FORGE_BACKEND_URL ?? "";

export function App() {
  const store = useUiStore();

  useEffect(() => {
    // Relative path means "same origin as the UI". Vite proxies /events + /snapshot
    // to the Forge backend in dev; in production FORGE_BACKEND_URL is injected.
    const stop = store.start(FORGE_BACKEND || "/");
    return stop;
  }, [store]);

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto", fontFamily: "system-ui, sans-serif", color: "#e3eaf2", backgroundColor: "#0a0f14", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 16px 0" }}>Forge</h1>
      <TaskHeader />
      <PlanView />
      <TimelineView />
      <VerificationPanel />
      <MemoryPanel />
      <RuntimeDetail />
      <div style={{ fontSize: 11, color: "#5a6a7a", marginTop: 24 }}>
        backend: {FORGE_BACKEND || "(not configured)"}
      </div>
    </div>
  );
}
