import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskSession } from "../shared/types.ts";

type PaletteAction = { id: string; label: string; hint?: string; run: () => void };

/** ⌘K quick-jump: actions + session search in one list, keyboard driven. */
export function CommandPalette({ open, onClose, sessions, actions, onPickSession }: {
  open: boolean;
  onClose: () => void;
  sessions: readonly TaskSession[];
  actions: readonly PaletteAction[];
  onPickSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focus after mount so the input is attached.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const acts = actions
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({ kind: "action" as const, id: a.id, label: a.label, hint: a.hint, run: a.run }));
    const sess = sessions
      .filter((s) => !q || s.goal.toLowerCase().includes(q) || s.id.includes(q))
      .map((s) => ({
        kind: "session" as const,
        id: s.id,
        label: s.goal || "(untitled)",
        hint: s.kind === "conversation" ? "conversation" : s.state.toLowerCase(),
        run: () => onPickSession(s.id),
      }));
    return [...acts, ...sess];
  }, [query, actions, sessions]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
  }, [items.length]);

  if (!open) return null;

  function run(index: number) {
    const item = items[index];
    if (!item) return;
    item.run();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(cursor);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 4000, background: "rgba(0,0,0,0.45)" }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        style={{ maxWidth: 560, margin: "12vh auto 0", background: "var(--bg-secondary)", border: "1px solid var(--border-strong)", borderRadius: 12, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.55)" }}
        onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a session, or run a command…"
          style={{ width: "100%", boxSizing: "border-box", padding: "13px 16px", border: "none", outline: "none", background: "transparent", color: "var(--text)", fontSize: 14.5, fontFamily: "inherit", borderBottom: "1px solid var(--border)" }}
        />
        <div ref={listRef} style={{ maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {items.length === 0 && <div style={{ padding: "18px 12px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>No matches</div>}
          {items.map((item, i) => (
            <div
              key={item.kind + item.id}
              onClick={() => run(i)}
              onMouseEnter={() => setCursor(i)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6,
                cursor: "pointer", fontSize: 13.5,
                background: i === cursor ? "var(--accent)" : "transparent",
                color: i === cursor ? "#fff" : "var(--text-secondary)",
              }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
              {item.hint && (
                <span style={{ fontSize: 11, color: i === cursor ? "rgba(255,255,255,0.75)" : "var(--text-muted)", flexShrink: 0 }}>{item.hint}</span>
              )}
            </div>
          ))}
        </div>
        <div style={{ padding: "6px 12px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 14 }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
