import { useUiStore, useStoreSnapshot } from "../lib/useUiStore.ts";
import type { Observation } from "../shared/types.ts";

export function VerificationPanel() {
  const store = useUiStore();
  const observations = useStoreSnapshot(store, (s) => s.task?.observations ?? []);

  if (observations.length === 0) {
    return <div style={panelStyle}>no observations yet</div>;
  }

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Verification</div>
      <div style={subStyle}>{observations.length} observation(s)</div>
      {observations.map((o) => (
        <ObservationRow key={o.id} obs={o} />
      ))}
    </div>
  );
}

function ObservationRow({ obs }: { obs: Observation }) {
  const pass = obs.result === "PASS";
  const color = pass ? "#2a9d4a" : "#a8323c";
  return (
    <div style={rowStyle}>
      <div style={{ ...pillStyle, backgroundColor: color }}>{obs.result}</div>
      <span style={stepStyle}>{obs.stepId}</span>
      <span style={attemptStyle}>attempt {obs.attempt}</span>
      {obs.failureReason ? (
        <div style={reasonStyle}>{obs.failureReason}</div>
      ) : null}
      <div style={criteriaStyle}>
        {obs.criterionResults.map((c, i) => {
          const cColor = c.passed ? "#2a9d4a" : "#a8323c";
          return (
            <div key={i} style={criterionRow}>
              <span style={{ ...criterionPill, backgroundColor: cColor }}>
                {c.passed ? "PASS" : "FAIL"}
              </span>
              <span style={kindStyle}>{c.criterion.kind}</span>
              <span style={msgStyle}>{c.message}</span>
              {c.exitCode !== undefined && c.exitCode !== -1 ? (
                <span style={exitStyle}>exit={c.exitCode}</span>
              ) : null}
            </div>
          );
        })}
      </div>
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

const titleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#e3eaf2", marginBottom: 4 };
const subStyle: React.CSSProperties = { fontSize: 12, color: "#7a8a9a", marginBottom: 12 };

const rowStyle: React.CSSProperties = {
  borderTop: "1px solid #1f2a38",
  padding: "8px 0",
};

const pillStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  color: "#fff",
  fontSize: 11,
  fontWeight: 700,
  marginRight: 8,
};

const stepStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  color: "#8a9aab",
  marginRight: 8,
};

const attemptStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#5a6a7a",
};

const reasonStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#e3eaf2",
  marginTop: 4,
};

const criteriaStyle: React.CSSProperties = { marginTop: 6 };

const criterionRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  padding: "2px 0",
};

const criterionPill: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 3,
  color: "#fff",
  fontSize: 10,
  fontWeight: 700,
  minWidth: 36,
  textAlign: "center",
};

const kindStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#8a9aab",
  minWidth: 140,
};

const msgStyle: React.CSSProperties = {
  flex: 1,
  color: "#cfd8e3",
};

const exitStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#5a6a7a",
};
