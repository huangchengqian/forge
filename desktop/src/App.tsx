import { useEffect } from "react";
import { store } from "./lib/store.ts";
import { initClient } from "./lib/api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Composer } from "./components/Composer.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { ApprovalDialog } from "./components/ApprovalDialog.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";

declare global {
  interface Window {
    __FORGE_CONFIG__?: { baseUrl: string; token: string };
  }
}

export function App() {
  const sessions = store((s) => s.sessions);
  const activeId = store((s) => s.activeSessionId);
  const theme = store((s) => s.theme);
  const settingsOpen = store((s) => s.settingsOpen);
  const pendingApproval = store((s) => s.pendingApproval);
  const refreshSessions = store((s) => s.refreshSessions);
  const setSettingsOpen = store((s) => s.setSettingsOpen);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("forge-theme", theme);
  }, [theme]);

  useEffect(() => {
    initClient(
      window.__FORGE_CONFIG__ ?? {
        baseUrl: "http://127.0.0.1:5300",
        token: localStorage.getItem("forge-token") ?? "",
      },
    );
    void refreshSessions();
    // Open the most recent session by default — zero-config startup.
    void store.getState().refreshSessions().then(() => {
      const latest = store.getState().sessions[0];
      if (latest) store.getState().select(latest.id);
    });
  }, [refreshSessions]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (settingsOpen) setSettingsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeProjectId = activeSession?.projectId ?? undefined;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar onNewSession={() => store.getState().select(null)} />
      <main
        className="app-main"
        style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}
      >
        {activeSession ? (
          <SessionView
            key={activeSession.id}
            sessionId={activeSession.id}
            goal={activeSession.goal}
            status={activeSession.status}
            failureReason={activeSession.failureReason}
            modelId={activeSession.model?.modelId ?? ""}
            trustLevel={activeSession.trustLevel}
          />
        ) : (
          <Composer projectId={activeProjectId} />
        )}
      </main>
      <ApprovalDialog request={pendingApproval} />
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
