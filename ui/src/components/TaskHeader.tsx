import { useUiStore, useStoreSnapshot } from "../lib/useUiStore.ts";

export function TaskHeader() {
  const store = useUiStore();
  const task = useStoreSnapshot(store, (s) => s.task);
  const startedAt = useStoreSnapshot(store, (s) =>
    s.events.find((e) => e.type === "task_started")?.at ?? null,
  );

  if (!task) {
    return <div style={panelStyle}>no task loaded</div>;
  }

  const now = Date.now();
  const durationMs = startedAt ? now - startedAt : 0;
  const durationLabel = formatDuration(durationMs);
  const stateColor = stateColors[task.state] ?? "#888";

  return (
    <div style={{ ...panelStyle, display: "flex", alignItems: "baseline", gap: 24 }}>
      <div>
        <div style={labelStyle}>goal</div>
        <div style={goalStyle}>{task.goal || "(none)"}</div>
      </div>
      <div>
        <div style={labelStyle}>state</div>
        <div style={{ ...statePillStyle, backgroundColor: stateColor }}>{task.state}</div>
      </div>
      <div>
        <div style={labelStyle}>duration</div>
        <div style={valueStyle}>{durationLabel}</div>
      </div>
      <div>
        <div style={labelStyle}>fixCount</div>
        <div style={valueStyle}>{task.fixCount}</div>
      </div>
      <div style={{ flex: 1 }} />
      <div>
        <div style={labelStyle}>id</div>
        <div style={{ ...valueStyle, fontFamily: "monospace" }}>{task.id}</div>
      </div>
    </div>
  );
}

const stateColors: Record<string, string> = {
  READY: "#444",
  UNDERSTAND: "#3a6ea5",
  PLAN: "#7d5ba6",
  EXECUTE: "#b58c2a",
  OBSERVE: "#3f8e5c",
  FIX: "#a8323c",
  COMPLETE: "#2a9d4a",
  FAILED: "#a8323c",
};

const panelStyle: React.CSSProperties = {
  backgroundColor: "#11161d",
  padding: 16,
  borderRadius: 8,
  border: "1px solid #1f2a38",
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#7a8a9a",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 4,
};

const goalStyle: React.CSSProperties = {
  fontSize: 16,
  color: "#e3eaf2",
  fontWeight: 500,
};

const valueStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#e3eaf2",
};

const statePillStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}
