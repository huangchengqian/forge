import { useState } from "react";
import type { TaskSession } from "../shared/types.ts";
import type { ProjectRecord } from "./ProjectsPage.tsx";
import { isTaskTerminal } from "./ApprovalCenter.tsx";

export function Sidebar({ projects, activeProjectId, onSelectProject, onAddProject, onNewTask, searchQuery, onSearchChange, sessions, onOpenSession, selectedSessionId, onSettings, settingsActive, theme, onToggleTheme, onDeleteSession, onRenameSession, onOpenMemory }: {
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
  onRenameSession: (id: string, goal: string) => Promise<void>;
  onOpenMemory: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [addingErr, setAddingErr] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);
  const [renaming, setRenaming] = useState<{ taskId: string; goal: string } | null>(null);
  const [pins, setPins] = useState<string[]>(() => pinnedIds());

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

  async function submitRename() {
    if (!renaming || !renaming.goal.trim()) return;
    try {
      await onRenameSession(renaming.taskId, renaming.goal.trim());
    } catch { /* keep menu closed; refresh shows old name */ }
    setRenaming(null);
  }

  const groups = groupSessions(sessions, pins);

  return (
    <div className="sidebar">
      <div className="sidebar-logo">Forge</div>

      {/* Project Switcher */}
      <div style={{ position: "relative", marginBottom: 6 }}>
        <button onClick={() => setSwitcherOpen((v) => !v)} className="input" style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: "var(--bg)" }}>
          <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeName}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>▾</span>
        </button>
        {switcherOpen && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 100, backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", padding: "6px 8px 4px", letterSpacing: "0.5px" }}>PROJECTS</div>
            {projects.map((p) => (
              <div key={p.id} onClick={() => { onSelectProject(p.id); setSwitcherOpen(false); }}
                className="ctx-menu-item-fake"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: 5, cursor: "pointer", fontSize: 13, color: p.id === activeProjectId ? "var(--text)" : "var(--text-secondary)", background: p.id === activeProjectId ? "var(--bg-secondary)" : "transparent" }}>
                <span>{p.name}</span>
                {p.id === activeProjectId && <span style={{ color: "var(--accent)" }}>●</span>}
              </div>
            ))}
            {projects.length === 0 && <div style={{ padding: "6px 8px", color: "var(--text-muted)", fontSize: 13 }}>No projects yet</div>}
            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "6px 0" }} />
            <div onClick={() => { onOpenMemory(); setSwitcherOpen(false); }} style={{ display: "flex", padding: "6px 8px", borderRadius: 5, cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
              <span>✦ Memory</span>
            </div>
            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "6px 0" }} />
            {adding ? (
              <div style={{ padding: "4px 6px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/absolute/path" className="input" style={{ fontSize: 12 }} autoFocus />
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="input" style={{ fontSize: 12 }} />
                {addingErr && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 6 }}>{addingErr}</div>}
                <button onClick={submitAdd} disabled={!path.trim()} className="btn btn-primary btn-small">Add Project</button>
              </div>
            ) : (
              <div onClick={() => setAdding(true)} style={{ display: "flex", padding: "6px 8px", borderRadius: 5, cursor: "pointer", fontSize: 13, color: "var(--accent)" }}>+ Add Project</div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <button onClick={onNewTask} className="sidebar-row-btn">+ New Task</button>
      <input id="session-search" value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search  (⌘F)" className="input" style={{ width: "100%", boxSizing: "border-box", margin: "4px 0 10px" }} />

      {/* Sessions */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {groups.length === 0 && <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "4px 8px" }}>No sessions</div>}
        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 8px 2px" }}>{g.label}</div>
            {g.items.map((s) => {
              const isRenaming = renaming?.taskId === s.id;
              return (
                <div key={s.id}
                  onClick={() => { if (!isRenaming) onOpenSession(s.id); }}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, taskId: s.id }); }}
                  className={`session-item ${s.id === selectedSessionId ? "selected" : ""}`}>
                  <span style={{ flexShrink: 0, display: "flex" }}>
                    <span className={`state-dot ${isTaskTerminal(s.state) ? "" : "running"}`} style={{ background: stateColor(s.state) }} />
                  </span>
                  {s.kind === "conversation" && <span className="kind-tag">chat</span>}
                  {isRenaming ? (
                    <input
                      value={renaming.goal}
                      autoFocus
                      onChange={(e) => setRenaming({ taskId: s.id, goal: e.target.value })}
                      onBlur={submitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="input"
                      style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "2px 6px" }}
                    />
                  ) : (
                    <>
                      <span className="title">{s.goal || "(untitled)"}</span>
                      <span className="time">{relativeTime(s.updatedAt)}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Theme + Settings */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8, display: "flex", gap: 4 }}>
        <button onClick={onToggleTheme} title="Toggle theme" className="sidebar-row-btn" style={{ width: 34, padding: "7px 0", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button onClick={onSettings} className="sidebar-row-btn" style={{ flex: 1, background: settingsActive ? "var(--bg-secondary)" : "transparent" }}>Settings</button>
      </div>

      {/* Context menu (right-click on a session) */}
      {ctxMenu && (
        <div style={{ position: "fixed", inset: 0, zIndex: 3000 }} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => {
              const s = sessions.find((x) => x.id === ctxMenu.taskId);
              setRenaming({ taskId: ctxMenu.taskId, goal: s?.goal ?? "" });
              setCtxMenu(null);
            }}>Rename</button>
            <button onClick={() => {
              const next = togglePinned(ctxMenu.taskId);
              setPins(next);
              setCtxMenu(null);
            }}>{pins.includes(ctxMenu.taskId) ? "Unpin" : "Pin to top"}</button>
            <button className="danger" onClick={() => { onDeleteSession(ctxMenu.taskId); setCtxMenu(null); }}>
              Delete session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function stateColor(s: string): string {
  return s === "COMPLETE" ? "var(--green)" : s === "FAILED" || s === "CANCELLED" ? "var(--red)" : s === "REVIEW_REQUIRED" ? "var(--yellow)" : "var(--accent)";
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

// --- pinned sessions (client-side projection preference) ---

const PIN_KEY = "forge-pinned-sessions";

function pinnedIds(): string[] {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as string[]; } catch { return []; }
}

function togglePinned(id: string): string[] {
  const cur = pinnedIds();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  localStorage.setItem(PIN_KEY, JSON.stringify(next));
  return next;
}

function groupSessions(sessions: readonly TaskSession[], pins: readonly string[]): Array<{ label: string; items: TaskSession[] }> {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const pinned: TaskSession[] = [];
  const rest = sorted.filter((s) => {
    if (pins.includes(s.id)) { pinned.push(s); return false; }
    return true;
  });
  pinned.sort((a, b) => b.updatedAt - a.updatedAt);

  const today: TaskSession[] = [];
  const yesterday: TaskSession[] = [];
  const earlier: TaskSession[] = [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const s of rest) {
    const dayStart = new Date(new Date(s.updatedAt).getFullYear(), new Date(s.updatedAt).getMonth(), new Date(s.updatedAt).getDate()).getTime();
    if (dayStart >= todayStart) today.push(s);
    else if (dayStart >= todayStart - 86_400_000) yesterday.push(s);
    else earlier.push(s);
  }
  const groups: Array<{ label: string; items: TaskSession[] }> = [];
  if (pinned.length) groups.push({ label: "Pinned", items: pinned });
  if (today.length) groups.push({ label: "Today", items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
  if (earlier.length) groups.push({ label: "Earlier", items: earlier });
  return groups;
}

// --- theme icons (inline SVG so they follow text color) ---

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}
