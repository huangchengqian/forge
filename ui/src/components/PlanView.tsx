import { useUiStore, useStoreSnapshot } from "../lib/useUiStore.ts";
import type { PlanStep } from "../shared/types.ts";

export function PlanView() {
  const store = useUiStore();
  const plan = useStoreSnapshot(store, (s) => s.task?.plan ?? null);

  if (!plan) {
    return <div style={panelStyle}>no plan</div>;
  }

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Plan</div>
      <div style={subStyle}>{plan.steps.length} step(s) · v{plan.version}</div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {plan.steps.map((s) => (
          <li key={s.id} style={itemStyle}>
            <span style={{ ...statusPill, ...statusColors[s.status] }}>
              {iconFor(s.status)}
            </span>
            <span style={stepIdStyle}>{s.id}</span>
            <span style={intentStyle} title={s.intent}>{s.intent}</span>
            <span style={metaStyle}>
              attempts={s.attempts}
              {s.successCriteria.length > 0 ? ` · ${s.successCriteria.length} crit` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  backgroundColor: "#11161d",
  padding: 16,
  borderRadius: 8,
  border: "1px solid #1f2a38",
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#e3eaf2",
  marginBottom: 4,
};

const subStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#7a8a9a",
  marginBottom: 12,
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 0",
  borderBottom: "1px solid #1f2a38",
};

const stepIdStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  color: "#8a9aab",
  minWidth: 60,
};

const intentStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  color: "#cfd8e3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#5a6a7a",
};

const statusPill: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 700,
  color: "#fff",
};

const statusColors: Record<PlanStep["status"], React.CSSProperties> = {
  pending: { backgroundColor: "#3a4a5a" },
  running: { backgroundColor: "#3a6ea5" },
  verified: { backgroundColor: "#2a9d4a" },
  failed: { backgroundColor: "#a8323c" },
};

function iconFor(status: PlanStep["status"]): string {
  switch (status) {
    case "pending":
      return "·";
    case "running":
      return "▶";
    case "verified":
      return "✓";
    case "failed":
      return "✗";
  }
}
