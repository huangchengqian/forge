import { useState } from "react";
import type { TaskSession } from "../shared/types.ts";
import type { ProjectRecord } from "./ProjectsPage.tsx";

export function Sidebar({ projects, activeProjectId, onSelectProject, onAddProject, onNewTask, searchQuery, onSearchChange, sessions, onOpenSession, selectedSessionId, onSettings, settingsActive, theme, onToggleTheme, onDeleteSession, onOpenMemory }: {
  projects: readonly ProjectRecord[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onAddProject: (path: string, name?: string) => Promise<void>;
  onNewTask: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sessions: readonly TaskSession[];
  onOpenSession: (id: string) => void;
  selectedSessionId: string | null;
  onSettings: () => void;
  settingsActive: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onDeleteSession: (id: string) => void;
  onOpenMemory: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [addingErr, setAddingErr] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);

  const activeName = projects.find((p) => p.id === activeProjectId)?.name ?? "No project";

  async function submitAdd() {
    if (!path.trim()) return;
    setAddingErr(null);
    try {
      await onAddProject(path.trim(), name.trim() || undefined);
      setPath(""); setName(""); setAdding(false);
    } catch (e) {
      setAddingErr(e instanceof Error ? e.message : String(e));
    }
  }

  const groups = groupSessions(sessions);

  return (
    <div style={sidebar}>
      <div style={logo}>Forge</div>

      {/* Project Switcher */}
      <div style={switcherWrap}>
        <button onClick={() => setSwitcherOpen((v) => !v)} style={switcherBtn}>
          <span style={switcherName}>{activeName}</span>
          <span style={switcherCaret}>▾</span>
        </button>
        {switcherOpen && (
          <div style={switcherPanel}>
            <div style={panelLabel}>PROJECTS</div>
            {projects.map((p) => (
              <div key={p.id} onClick={() => { onSelectProject(p.id); setSwitcherOpen(false); }}
                style={{ ...panelItem, background: p.id === activeProjectId ? "var(--bg-secondary)" : "transparent" }}>
                <span style={{ color: p.id === activeProjectId ? "var(--text)" : "var(--text-secondary)" }}>{p.name}</span>
                {p.id === activeProjectId && <span style={{ color: "var(--accent)" }}>●</span>}
              </div>
            ))}
            {projects.length === 0 && <div style={{ ...panelItem, color: "var(--text-muted)" }}>No projects yet</div>}
            <div style={panelDivider} />
            <div onClick={() => { onOpenMemory(); setSwitcherOpen(false); }} style={panelItem}>
              <span style={{ color: "var(--text-secondary)" }}>✦ Memory</span>
            </div>
            <div style={panelDivider} />
            {adding ? (
              <div style={addForm}>
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/absolute/path" style={addInput} autoFocus />
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" style={addInput} />
                {addingErr && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 6 }}>{addingErr}</div>}
                <button onClick={submitAdd} disabled={!path.trim()} style={addBtn}>Add Project</button>
              </div>
            ) : (
              <div onClick={() => setAdding(true)} style={{ ...panelItem, color: "var(--accent)" }}>+ Add Project</div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <button onClick={onNewTask} style={newTaskBtn}>+ New Task</button>
      <input value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search" style={searchInput} />

      {/* Sessions */}
      <div style={sessionsSection}>
        <div style={sessionsLabel}>SESSIONS</div>
        {groups.length === 0 && <div style={noSessions}>No sessions</div>}
        {groups.map((g) => (
          <div key={g.label} style={groupBlock}>
            <div style={groupLabel}>{g.label}</div>
            {g.items.map((s) => (
              <div key={s.id} onClick={() => onOpenSession(s.id)}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, taskId: s.id }); }}
                style={{ ...sessionItem, background: s.id === selectedSessionId ? "var(--accent)" : "transparent" }}>
                <span style={dotWrap}><span style={{ ...dot, background: stateColor(s.state) }} /></span>
                {s.kind === "conversation" && <span style={{ flexShrink: 0, fontSize: 11 }}>💬</span>}
                <span style={{ ...sessionTitle, color: s.id === selectedSessionId ? "#fff" : "var(--text-secondary)" }}>{s.goal || "(untitled)"}</span>
                <span style={sessionTime}>{relativeTime(s.updatedAt)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Theme + Settings */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8, display: "flex", gap: 4 }}>
        <button onClick={onToggleTheme} title="Toggle theme" style={themeBtn}>
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <button onClick={onSettings} style={{ ...settingsBtn, flex: 1, background: settingsActive ? "var(--bg-secondary)" : "transparent" }}>Settings</button>
      </div>

      {/* Context menu (right-click on a session) */}
      {ctxMenu && (
        <div style={ctxOverlay} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <div style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => { onDeleteSession(ctxMenu.taskId); setCtxMenu(null); }} style={ctxMenuItem}>
              Delete session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function stateColor(s: string): string {
  return s === "COMPLETE" ? "var(--green)" : s === "FAILED" ? "var(--red)" : s === "REVIEW_REQUIRED" ? "var(--yellow)" : "var(--accent)";
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function groupSessions(sessions: readonly TaskSession[]): Array<{ label: string; items: TaskSession[] }> {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const today: TaskSession[] = [];
  const yesterday: TaskSession[] = [];
  const earlier: TaskSession[] = [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const s of sorted) {
    const dayStart = new Date(new Date(s.updatedAt).getFullYear(), new Date(s.updatedAt).getMonth(), new Date(s.updatedAt).getDate()).getTime();
    if (dayStart >= todayStart) today.push(s);
    else if (dayStart >= todayStart - 86_400_000) yesterday.push(s);
    else earlier.push(s);
  }
  const groups: Array<{ label: string; items: TaskSession[] }> = [];
  if (today.length) groups.push({ label: "Today", items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
  if (earlier.length) groups.push({ label: "Earlier", items: earlier });
  return groups;
}

const sidebar = {
  width: 260, flexShrink: 0, height: "100vh", backgroundColor: "var(--bg)",
  borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" as const, padding: "12px 10px",
  boxSizing: "border-box" as const, overflowY: "auto" as const,
};
const logo = { fontSize: 15, fontWeight: 700, color: "var(--text)", padding: "4px 8px 12px", letterSpacing: "0.3px" };
const switcherWrap = { position: "relative" as const, marginBottom: 6 };
const switcherBtn = {
  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg)",
  color: "var(--text)", cursor: "pointer", fontSize: 13,
};
const switcherName = { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
const switcherCaret = { color: "var(--text-muted)", fontSize: 11 };
const switcherPanel = {
  position: "absolute" as const, top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 100,
  backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: 6,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
};
const panelLabel = { fontSize: 10, fontWeight: 600, color: "var(--text-muted)", padding: "6px 8px 4px", letterSpacing: "0.5px" };
const panelItem = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: 5, cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" };
const panelDivider = { height: 1, backgroundColor: "var(--border)", margin: "6px 0" };
const addForm = { padding: "4px 6px 6px", display: "flex", flexDirection: "column" as const, gap: 6 };
const addInput = { padding: "6px 8px", borderRadius: 5, border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" };
const addBtn = { padding: "6px 10px", borderRadius: 5, border: "none", backgroundColor: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const newTaskBtn = { width: "100%", textAlign: "left" as const, padding: "7px 10px", borderRadius: 6, border: "none", backgroundColor: "transparent", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" };
const searchInput = { width: "100%", boxSizing: "border-box" as const, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: 13, margin: "4px 0 10px", outline: "none" };
const sessionsSection = { flex: 1, minHeight: 0, overflowY: "auto" as const };
const sessionsLabel = { fontSize: 10, fontWeight: 600, color: "var(--text-muted)", padding: "8px 8px 4px", letterSpacing: "0.5px" };
const noSessions = { color: "var(--text-muted)", fontSize: 12, padding: "4px 8px" };
const groupBlock = { marginBottom: 4 };
const groupLabel = { fontSize: 11, color: "var(--text-muted)", padding: "6px 8px 2px" };
const sessionItem = { display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const dotWrap = { flexShrink: 0, display: "flex" };
const dot = { width: 7, height: 7, borderRadius: 99, display: "inline-block" };
const sessionTitle = { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
const sessionTime = { fontSize: 11, color: "var(--text-muted)", flexShrink: 0 };
const settingsBtn = { width: "100%", textAlign: "left" as const, padding: "7px 10px", borderRadius: 6, border: "none", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" };
const themeBtn = { width: 34, padding: "7px 0", borderRadius: 6, border: "none", backgroundColor: "transparent", cursor: "pointer", fontSize: 14 };
const ctxOverlay = { position: "fixed" as const, inset: 0, zIndex: 3000 };
const ctxMenuItem = { display: "block", width: 180, textAlign: "left" as const, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", color: "var(--red)", fontSize: 13, cursor: "pointer", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" };
