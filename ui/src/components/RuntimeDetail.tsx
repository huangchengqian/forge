import { useState } from "react";
import { useUiStore, useStoreSnapshot } from "../lib/useUiStore.ts";
import type { ForgeEvent } from "../shared/types.ts";

const MAX_TEXT_CHARS = 2000;

export function RuntimeDetail() {
  const store = useUiStore();
  const events = useStoreSnapshot(store, (s) => s.events);
  const [open, setOpen] = useState(false);

  const piEvents = events.filter((e): e is Extract<ForgeEvent, { type: "pi_event" }> => e.type === "pi_event");
  if (piEvents.length === 0) {
    return null;
  }

  const sample = piEvents.slice(-10);

  return (
    <div style={panelStyle}>
      <button onClick={() => setOpen(!open)} style={toggleStyle}>
        {open ? "▼" : "▶"} Runtime Detail ({piEvents.length} pi event(s))
      </button>
      {open ? (
        <div style={bodyStyle}>
          {sample.map((e, i) => (
            <pre key={i} style={preStyle}>
              {summarize(e.payload)}
            </pre>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function summarize(payload: unknown): string {
  if (!payload || typeof payload !== "object") return JSON.stringify(payload);
  const p = payload as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof p.type === "string") lines.push(`type: ${p.type}`);
  if ("assistantMessageEvent" in p) {
    const inner = p.assistantMessageEvent as { type?: string; delta?: string };
    if (inner.delta) lines.push(`delta: ${truncate(inner.delta)}`);
  }
  if ("toolCall" in p) {
    const tc = p.toolCall as { name?: string };
    if (tc.name) lines.push(`tool: ${tc.name}`);
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(p, null, 2).slice(0, MAX_TEXT_CHARS);
}

function truncate(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + "..." : s;
}

const panelStyle: React.CSSProperties = {
  backgroundColor: "#11161d",
  padding: 12,
  borderRadius: 8,
  border: "1px solid #1f2a38",
  marginBottom: 12,
};

const toggleStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#cfd8e3",
  cursor: "pointer",
  fontSize: 13,
  padding: 4,
};

const bodyStyle: React.CSSProperties = {
  marginTop: 8,
  borderTop: "1px solid #1f2a38",
  paddingTop: 8,
};

const preStyle: React.CSSProperties = {
  backgroundColor: "#0a0f14",
  padding: 8,
  borderRadius: 4,
  fontFamily: "monospace",
  fontSize: 11,
  color: "#9aabbb",
  margin: "4px 0",
  overflow: "auto",
  maxHeight: 200,
};
