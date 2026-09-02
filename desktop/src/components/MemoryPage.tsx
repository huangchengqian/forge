import { useMemo, useState } from "react";
import type { MemoryItem, MemoryType } from "../shared/types.ts";

const GROUPS: Array<{ label: string; types: MemoryType[] }> = [
  { label: "Facts", types: ["PROJECT_FACT", "DECISION"] },
  { label: "Solutions", types: ["SOLUTION"] },
  { label: "Failures", types: ["FAILURE_PATTERN"] },
];

export function MemoryPage({ memory, onBack, onDelete, onOpenTask }: {
  memory: readonly MemoryItem[];
  onBack: () => void;
  onDelete: (id: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? memory.filter((m) => m.content.toLowerCase().includes(q) || m.type.toLowerCase().includes(q)) : memory),
    [memory, q],
  );

  async function handleDelete(id: string) {
    if (deleting) return;
    setDeleting(id);
    try {
      await onDelete(id);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 28px 40px" }}>
        <div style={headRow}>
          <button onClick={onBack} style={backBtn}>← Back</button>
          <span style={title}>Memory</span>
          <span style={count}>{filtered.length} items</span>
        </div>
        <p style={subtitle}>
          Knowledge the agent has accumulated from past sessions — automatically retrieved when planning new tasks.
        </p>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memory…"
          style={search}
        />

        {filtered.length === 0 && (
          <div style={empty}>
            {memory.length === 0
              ? "No memories yet — they accumulate automatically as the agent completes tasks."
              : "No matches."}
          </div>
        )}

        {GROUPS.map((g) => {
          const items = filtered.filter((m) => g.types.includes(m.type));
          if (items.length === 0) return null;
          return (
            <div key={g.label} style={{ marginTop: 22 }}>
              <div style={groupLabel}>{g.label}</div>
              {items.map((m) => (
                <div key={m.id} style={item}>
                  <div style={itemContent}>{m.content}</div>
                  <div style={metaRow}>
                    <span style={{ ...typeTag, color: typeColor(m.type) }}>{m.type}</span>
                    <span style={meta}>conf {m.confidence}</span>
                    <span style={meta}>{new Date(m.createdAt).toLocaleDateString()}</span>
                    {m.taskRefs.slice(0, 2).map((t) => (
                      <button key={t} onClick={() => onOpenTask(t)} style={taskRefBtn} title={`Open source session ${t}`}>
                        {t.length > 18 ? t.slice(0, 18) + "…" : t}
                      </button>
                    ))}
                    <span style={{ flex: 1 }} />
                    <button onClick={() => handleDelete(m.id)} disabled={deleting === m.id} style={delBtn}>
                      {deleting === m.id ? "…" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function typeColor(t: string): string {
  return t === "SOLUTION" ? "var(--green)" : t === "FAILURE_PATTERN" ? "var(--red)" : t === "DECISION" ? "var(--yellow)" : "var(--accent)";
}

const headRow = { display: "flex", alignItems: "center", gap: 12 };
const backBtn = { padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13 };
const title = { fontSize: 17, fontWeight: 700, color: "var(--text)", flex: 1 };
const count = { fontSize: 12, color: "var(--text-muted)" };
const subtitle = { fontSize: 12.5, color: "var(--text-muted)", margin: "10px 0 16px", lineHeight: 1.5 };
const search = { width: "100%", boxSizing: "border-box" as const, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", color: "var(--text)", fontSize: 13, outline: "none" };
const empty = { color: "var(--text-muted)", fontSize: 13, marginTop: 32, textAlign: "center" as const };
const groupLabel = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.5px", textTransform: "uppercase" as const, marginBottom: 8 };
const item = { padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", marginBottom: 8 };
const itemContent = { fontSize: 13.5, color: "var(--text)", lineHeight: 1.6, marginBottom: 8 };
const metaRow = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const };
const typeTag = { fontFamily: "monospace", fontSize: 10.5, fontWeight: 600 };
const meta = { fontSize: 11, color: "var(--text-muted)" };
const taskRefBtn = { padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", backgroundColor: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontFamily: "monospace" };
const delBtn = { padding: "3px 10px", borderRadius: 5, border: "1px solid var(--border-strong)", backgroundColor: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11.5 };
