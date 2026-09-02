import { useUiStore, useStoreSnapshot } from "../lib/useUiStore.ts";
import type { ForgeEvent } from "../shared/types.ts";

export function TimelineView() {
  const store = useUiStore();
  const events = useStoreSnapshot(store, (s) => s.events);

  const shown = events.filter(isMilestone);

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Timeline</div>
      <div style={subStyle}>{shown.length} milestone(s)</div>
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {shown.map((e, i) => (
          <li key={i} style={itemStyle}>
            <span style={dotStyle} />
            <span style={timeStyle}>{formatTime(e.at)}</span>
            <span style={eventStyle}>{label(e)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const milestoneTypes: Set<ForgeEvent["type"]> = new Set([
  "task_started",
  "state_changed",
  "step_started",
  "step_verified",
  "fix_started",
  "memory_retrieved",
  "memory_extracted",
  "completed",
  "failed",
]);

function isMilestone(e: ForgeEvent): boolean {
  return milestoneTypes.has(e.type);
}

function label(e: ForgeEvent): string {
  switch (e.type) {
    case "task_started":
      return `task started: ${e.goal}`;
    case "state_changed":
      return `state: ${e.from} → ${e.to}`;
    case "step_started":
      return `step started: ${e.stepId}`;
    case "step_verified":
      return `step verified: ${e.stepId}`;
    case "fix_started":
      return `FIX ${e.stepId} (attempt ${e.attempt}) — ${e.reason}`;
    case "memory_retrieved":
      return `memory retrieved: ${e.results.length} item(s) for "${e.query}"`;
    case "memory_extracted":
      return `memory extracted: ${e.items.length} fact(s)`;
    case "completed":
      return "task COMPLETE";
    case "failed":
      return `task FAILED: ${e.reason}`;
    case "pi_event":
      return `pi event (hidden)`;
  }
}

function formatTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const panelStyle: React.CSSProperties = {
  backgroundColor: "#11161d",
  padding: 16,
  borderRadius: 8,
  border: "1px solid #1f2a38",
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#e3eaf2", marginBottom: 4 };
const subStyle: React.CSSProperties = { fontSize: 12, color: "#7a8a9a", marginBottom: 12 };

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "4px 0",
  fontSize: 13,
};

const dotStyle: React.CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  backgroundColor: "#3a6ea5",
};

const timeStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#5a6a7a",
  minWidth: 60,
};

const eventStyle: React.CSSProperties = { color: "#cfd8e3" };
