import { useEffect, useRef, useState } from "react";

export function SessionComposer({ onSubmit, focusSignal }: {
  onSubmit: (goal: string) => Promise<void>;
  focusSignal?: number;
}) {
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal !== undefined) inputRef.current?.focus();
  }, [focusSignal]);

  async function handleSubmit() {
    const g = goal.trim();
    if (!g || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(g);
      setGoal("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSubmitting(false);
  }

  return (
    <div>
      <div style={inputWrap}>
        <textarea
          ref={inputRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSubmit(); }}
          placeholder="Ask Forge to build, fix, or change something…"
          style={ta}
          rows={3}
        />
      </div>
      <div style={row}>
        <button onClick={handleSubmit} disabled={!goal.trim() || submitting} style={runBtn}>
          {submitting ? "Starting…" : "Run"}
        </button>
        {error && <span style={err}>{error}</span>}
      </div>
    </div>
  );
}

const inputWrap = {
  border: "1px solid var(--border-strong)", borderRadius: 12, padding: "6px 12px", backgroundColor: "var(--bg-secondary)",
  transition: "border-color 0.15s",
};
const ta = {
  width: "100%", padding: "8px 2px", border: "none", backgroundColor: "transparent",
  color: "var(--text)", fontSize: 15, lineHeight: 1.6, resize: "none" as const,
  boxSizing: "border-box" as const, outline: "none", fontFamily: "inherit",
};
const row = { display: "flex", alignItems: "center", gap: 12, marginTop: 12 };
const runBtn = {
  padding: "8px 22px", borderRadius: 8, border: "none", backgroundColor: "var(--accent)",
  color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const err = { color: "var(--red)", fontSize: 13 };
