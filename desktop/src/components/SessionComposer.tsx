import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function SessionComposer({ onSubmit, focusSignal, leftSlot, seed }: {
  onSubmit: (goal: string) => Promise<void>;
  focusSignal?: number;
  /** Optional control rendered at the left of the bottom row (e.g. model picker). */
  leftSlot?: ReactNode;
  /** External text insertion (e.g. empty-state suggestions): { text, nonce }. */
  seed?: { text: string; nonce: number };
}) {
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal !== undefined) inputRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    if (!seed) return;
    setGoal(seed.text);
    inputRef.current?.focus();
  }, [seed?.nonce]);

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
      <div className="composer-box">
        <textarea
          ref={inputRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSubmit(); }}
          placeholder="Ask Forge to build, fix, or change something…  (⌘Enter to run)"
          className="composer-ta"
          rows={3}
        />
      </div>
      <div className="composer-actions" style={{ marginTop: 10 }}>
        {leftSlot}
        {error && <span style={{ color: "var(--red)", fontSize: 12, alignSelf: "center" }}>{error}</span>}
        <button onClick={handleSubmit} disabled={!goal.trim() || submitting} className="btn btn-primary btn-small" style={{ marginLeft: "auto" }}>
          {submitting ? "Starting…" : "Run"}
        </button>
      </div>
    </div>
  );
}
