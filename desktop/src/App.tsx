import { useEffect, useState } from "react";
import { useDesktop } from "./lib/useDesktopStore.ts";
import { initClient, getConfig, saveConfig, testConnection, deleteMemory as deleteMemoryApi } from "./lib/desktop-client.ts";
import type { ProviderCheckResult } from "./lib/desktop-client.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import type { ProjectRecord } from "./components/ProjectsPage.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { SessionComposer } from "./components/SessionComposer.tsx";
import { MemoryPage } from "./components/MemoryPage.tsx";
import { ApprovalCenter, isTaskTerminal } from "./components/ApprovalCenter.tsx";

declare global {
  interface Window {
    __FORGE_CONFIG__?: { baseUrl: string; token: string };
  }
}

const cfg = window.__FORGE_CONFIG__ ?? { baseUrl: "http://127.0.0.1:5300", token: "" };

type ConfigData = {
  provider: { kind: string; apiKey: string; modelId: string; baseUrl: string } | null;
  maxConcurrency: number;
};

export function App() {
  const store = useDesktop();
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [composerFocus, setComposerFocus] = useState(0);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("forge-theme") as "dark" | "light") || "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("forge-theme", theme);
  }, [theme]);

  async function loadAll() {
    try {
      initClient(cfg);
      const [cfgData, projList] = await Promise.all([
        getConfig(),
        getJson<{ projects: readonly ProjectRecord[]; activeProjectId: string | null }>("/projects"),
      ]);
      setConfigData(cfgData as ConfigData);
      setProjects(projList.projects);
      setActiveProjectId(projList.activeProjectId);
    } catch {
      setConfigData({ provider: null, maxConcurrency: 2 });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    initClient(cfg);
    loadAll();
  }, []);

  useEffect(() => {
    if (!configData) return;
    void store.refreshTasks();
  }, [store, configData]);

  async function selectProject(id: string) {
    await fetch(`${cfg.baseUrl}/projects/${id}/select`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}` } });
    store.select(""); // never show another project's session
    await loadAll();
  }

  async function addProject(path: string, name?: string) {
    const res = await fetch(`${cfg.baseUrl}/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path, name }),
    });
    if (!res.ok) {
      let msg = `POST /projects → ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === "string") msg = body.error;
      } catch { /* keep status fallback */ }
      throw new Error(msg);
    }
    await loadAll();
  }

  function newTask() {
    store.select(""); // back to empty workspace
    setShowSettings(false);
    setShowMemory(false);
    setComposerFocus((n) => n + 1); // refocus the composer
  }

  function openSession(id: string) {
    setShowSettings(false);
    setShowMemory(false);
    store.select(id);
  }

  if (loading) {
    return <div style={loadingStyle}>Forge</div>;
  }

  const selectedTask = store.state.tasks.find((t) => t.id === store.state.selectedTaskId);

  const scopedSessions = activeProjectId
    ? store.state.tasks.filter((t) => t.projectId === activeProjectId)
    : store.state.tasks.filter((t) => !t.projectId);
  const q = searchQuery.trim().toLowerCase();
  const filteredSessions = q ? scopedSessions.filter((s) => s.goal.toLowerCase().includes(q) || s.id.includes(q)) : scopedSessions;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "var(--bg)", color: "var(--text)" }}>
      <Sidebar
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={selectProject}
        onAddProject={addProject}
        onNewTask={newTask}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sessions={filteredSessions}
        onOpenSession={openSession}
        selectedSessionId={store.state.selectedTaskId}
        onSettings={() => { setShowMemory(false); setShowSettings((v) => !v); }}
        settingsActive={showSettings}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onDeleteSession={async (id) => { await store.deleteSession(id); }}
        onOpenMemory={() => { setShowSettings(false); setShowMemory(true); store.select(""); }}
      />

      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {showMemory ? (
          <MemoryPage
            memory={store.state.memory}
            onBack={() => setShowMemory(false)}
            onDelete={async (id) => { await deleteMemoryApi(id); await store.refreshTasks(); }}
            onOpenTask={(taskId) => { setShowMemory(false); store.select(taskId); }}
          />
        ) : showSettings ? (
          configData && (
            <div style={{ flex: 1, overflow: "auto" }}>
              <SettingsPage
                key={JSON.stringify(configData)}
                config={configData}
                testResult={null}
                onSave={async (partial) => { await saveConfig(partial); await loadAll(); }}
                onTest={async (provider) => { initClient(cfg); return testConnection(provider); }}
              />
            </div>
          )
        ) : store.state.selectedTaskId && selectedTask ? (
          <SessionView task={selectedTask} memory={store.state.memory} liveEvents={store.state.liveEvents}
            onSend={async (msg) => { await store.sendMessage(selectedTask.id, msg); }} />
        ) : (
          <EmptyWorkspace focusSignal={composerFocus} activeProjectName={projects.find((p) => p.id === activeProjectId)?.name ?? null}
            onSubmit={async (goal) => {
              const taskId = await store.createTask({ goal });
              store.select(taskId);
            }} />
        )}
      </main>

      <ApprovalCenter
        taskId={store.state.selectedTaskId ?? store.state.tasks.find((t) => !isTaskTerminal(t.state))?.id ?? null}
        baseUrl={cfg.baseUrl}
        token={cfg.token}
      />
    </div>
  );
}

function EmptyWorkspace({ focusSignal, activeProjectName, onSubmit }: {
  focusSignal: number;
  activeProjectName: string | null;
  onSubmit: (goal: string) => Promise<void>;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div style={{ fontSize: 24, fontWeight: 600, color: "var(--text)", marginBottom: 6, textAlign: "center" as const }}>
          What would you like to build?
        </div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center" as const, marginBottom: 24 }}>
          {activeProjectName ? `Working in ${activeProjectName}` : "No project selected — sessions will be unassigned"}
        </div>
        <SessionComposer onSubmit={onSubmit} focusSignal={focusSignal} />
      </div>
    </div>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${cfg.baseUrl}${path}`, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

const loadingStyle = { display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", color: "var(--text-muted)", backgroundColor: "var(--bg)" };
