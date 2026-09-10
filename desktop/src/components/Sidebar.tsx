import { useEffect, useState } from "react";
import { store } from "../lib/store.ts";
import { addProject, fetchProjects, selectProject } from "../lib/api.ts";
import type { ProjectRecord } from "../types.ts";
import type { SessionStatus } from "../types.ts";

const statusColor: Record<SessionStatus, string> = {
  running: "var(--accent)",
  completed: "var(--green)",
  failed: "var(--red)",
  cancelled: "var(--text-muted)",
};

const statusLabel: Record<SessionStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Compact relative time for the session list ("3m", "2h", "5d"). */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function Sidebar({ onNewSession }: { onNewSession: () => void }) {
  const sessions = store((s) => s.sessions);
  const activeId = store((s) => s.activeSessionId);
  const select = store((s) => s.select);
  const remove = store((s) => s.remove);
  const theme = store((s) => s.theme);
  const toggleTheme = store((s) => s.toggleTheme);
  const openSettings = store((s) => s.setSettingsOpen);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);

  useEffect(() => {
    void fetchProjects().then((r) => {
      setProjects(r.projects);
      setActiveProject(r.activeProjectId);
    }).catch(() => {});
  }, []);

  async function onSwitchProject(id: string) {
    setActiveProject(id);
    try {
      await selectProject(id);
    } catch { /* registry keeps prior state on failure */ }
  }

  async function onAddProject() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
      if (typeof picked !== "string" || !picked) return;
      const created = await addProject(picked);
      setActiveProject(created.id);
      await selectProject(created.id);
      setProjects((await fetchProjects()).projects);
    } catch (err) {
      console.error("add project failed:", err);
    }
  }

  return (
    <div className="sidebar">
      {/* macOS traffic lights overlay this strip — keep it clear of content. */}
      <div className="sidebar-drag" />
      <div className="sidebar-brand">Forge<span>.</span></div>

      <div className="side-header-row" style={{ marginTop: 4 }}>
        <div className="side-section-label">Project</div>
        <button className="side-add-btn" onClick={() => void onAddProject()} title="Add project folder">
          +
        </button>
      </div>
      <select
        className="side-trigger"
        value={activeProject ?? ""}
        onChange={(e) => void onSwitchProject(e.target.value)}
        style={{ marginBottom: 10 }}
      >
        {projects.length === 0 && <option value="">No project</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      <div className="side-header-row">
        <div className="side-section-label">Sessions</div>
        <button
          className="side-add-btn"
          onClick={onNewSession}
          title="New session"
        >
          +
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {sessions.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 8px" }}>
            No sessions yet
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "selected" : ""}`}
            onClick={() => select(s.id)}
          >
            <span
              className="state-dot"
              style={{ background: statusColor[s.status] }}
              title={statusLabel[s.status]}
            />
            <span className="title" title={s.goal}>{s.goal || "(untitled)"}</span>
            <span className="kind-tag">{s.kind === "task" ? "TASK" : "CHAT"}</span>
            <span className="time">{timeAgo(s.updatedAt)}</span>
            {s.id === activeId && (
              <button
                className="side-icon-btn session-del"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s.id);
                }}
                title="Delete session"
                style={{ padding: "2px 5px", fontSize: 10, lineHeight: 1 }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="side-bottom">
        <button className="side-bottom-btn" onClick={() => openSettings(true)}>
          <span>⚙ Settings</span>
        </button>
        <button
          className="side-bottom-btn side-icon-btn"
          onClick={toggleTheme}
          title="Toggle theme"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </div>
  );
}

export { statusLabel };
export function SidebarDeleteButton({ id }: { id: string }) {
  const remove = store((s) => s.remove);
  return (
    <button
      className="btn btn-danger btn-small"
      style={{ padding: "1px 6px", fontSize: 10 }}
      onClick={(e) => {
        e.stopPropagation();
        void remove(id);
      }}
    >
      ✕
    </button>
  );
}
