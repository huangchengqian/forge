import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type ProjectRecord = { id: string; name: string; path: string; createdAt: number; lastOpenedAt: number };

/** True inside the Tauri desktop shell (native dialogs available). False in a plain browser (vite dev). */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function ProjectsPage({ projects, activeId, onSelect, onAdd }: {
  projects: readonly ProjectRecord[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (path: string, name?: string) => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canPickDir = isTauri();

  async function pickDirectory() {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "选择项目目录" });
      if (typeof dir === "string") {
        setNewPath(dir);
        // Derive a sensible default name from the folder name when empty.
        if (!newName.trim()) {
          const base = dir.split("/").filter(Boolean).pop();
          if (base) setNewName(base);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开目录选择器");
    }
  }

  async function handleAdd() {
    if (!newPath.trim()) return;
    setAdding(true); setError(null);
    try { await onAdd(newPath, newName || undefined); setShowAdd(false); setNewPath(""); setNewName(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setAdding(false);
  }

  return (
    <div style={pageStyle}>
      <div style={headerRow}>
        <h2 style={h2}>Projects</h2>
        {!showAdd && <button onClick={() => setShowAdd(true)} style={addBtn}>+ Add Project</button>}
      </div>
      {showAdd && (
        <div style={addForm}>
          <div style={lbl}>Path</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/absolute/path/to/project" style={{ ...inp, flex: 1 }} />
            {canPickDir && <button onClick={pickDirectory} style={browseBtn}>浏览…</button>}
          </div>
          <div style={lbl}>Name (optional)</div>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-project" style={inp} />
          <button onClick={handleAdd} disabled={!newPath || adding} style={saveBtn}>{adding ? "Adding…" : "Add"}</button>
          <button onClick={() => setShowAdd(false)} style={{ ...cancelBtn, marginLeft: 8 }}>Cancel</button>
          {error && <div style={errMsg}>{error}</div>}
        </div>
      )}
      {projects.length === 0 ? (
        <p style={empty}>No projects registered.</p>
      ) : (
        projects.map((p) => (
          <div key={p.id} onClick={() => onSelect(p.id)}
            style={{ ...card, borderColor: p.id === activeId ? "var(--accent)" : "var(--border)", borderWidth: p.id === activeId ? 2 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={nameStyle}>{p.name}{p.id === activeId && <span style={activeTag}> ACTIVE</span>}</span>
              <span style={pathStyle}>{p.path}</span>
            </div>
            <div style={metaRow}>opened {new Date(p.lastOpenedAt).toLocaleString()}</div>
          </div>
        ))
      )}
    </div>
  );
}

const pageStyle = { padding: 16 };
const headerRow = { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 };
const h2 = { fontSize: 18, margin: 0 };
const addBtn = { padding: "6px 14px", borderRadius: 4, border: "1px solid var(--accent)", backgroundColor: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 13 };
const addForm = { backgroundColor: "var(--bg-secondary)", padding: 16, borderRadius: 6, marginBottom: 12 };
const lbl = { fontSize: 11, color: "var(--text-muted)", margin: "8px 0 2px" };
const inp = { width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", boxSizing: "border-box" as const };
const browseBtn = { padding: "6px 14px", borderRadius: 4, border: "1px solid var(--accent)", backgroundColor: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" as const };
const saveBtn = { padding: "8px 16px", borderRadius: 4, border: "none", backgroundColor: "var(--accent)", color: "#fff", cursor: "pointer", marginTop: 12 };
const cancelBtn = { padding: "8px 16px", borderRadius: 4, border: "1px solid var(--border)", backgroundColor: "transparent", color: "var(--text-secondary)", cursor: "pointer", marginTop: 12 };
const errMsg = { color: "var(--red)", fontSize: 12, marginTop: 8 };
const empty = { color: "var(--text-muted)", marginTop: 24 };
const card = { backgroundColor: "var(--bg-secondary)", padding: 12, borderRadius: 6, marginBottom: 8, cursor: "pointer", border: "1px solid" };
const nameStyle = { fontWeight: 600, color: "var(--text)", fontSize: 14 };
const activeTag = { fontSize: 10, color: "var(--accent)", fontWeight: 700, marginLeft: 6 };
const pathStyle = { fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" };
const metaRow = { fontSize: 11, color: "var(--text-muted)", marginTop: 4 };
