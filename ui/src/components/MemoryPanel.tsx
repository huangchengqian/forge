import { useUiStore, useStoreSnapshot } from "../lib/useUiStore.ts";
import type { MemoryItem } from "../shared/types.ts";

export function MemoryPanel() {
  const store = useUiStore();
  const memory = useStoreSnapshot(store, (s) => s.memory);

  if (memory.length === 0) {
    return <div style={panelStyle}>no memory items yet</div>;
  }

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Memory</div>
      <div style={subStyle}>{memory.length} fact(s)</div>
      {memory.map((m) => (
        <div key={m.id} style={itemStyle}>
          <div style={{ ...typePill, backgroundColor: typeColor(m.type) }}>{m.type}</div>
          <span style={sourceStyle}>{m.source}</span>
          <span style={confStyle}>conf={m.confidence.toFixed(2)}</span>
          <div style={contentStyle}>{m.content}</div>
          {m.keywords.length > 0 ? (
            <div style={kwStyle}>
              {m.keywords.map((k, i) => (
                <span key={i} style={kwPill}>{k}</span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function typeColor(type: string): string {
  switch (type) {
    case "PROJECT_FACT":
      return "#3a6ea5";
    case "SOLUTION":
      return "#2a9d4a";
    case "FAILURE_PATTERN":
      return "#a8323c";
    case "DECISION":
      return "#7d5ba6";
  }
  return "#666";
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
  borderTop: "1px solid #1f2a38",
  padding: "8px 0",
};

const typePill: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  color: "#fff",
  fontSize: 11,
  fontWeight: 700,
  marginRight: 8,
};

const sourceStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#8a9aab",
  marginRight: 8,
};

const confStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#5a6a7a",
  marginRight: 8,
};

const contentStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#cfd8e3",
  marginTop: 4,
};

const kwStyle: React.CSSProperties = {
  marginTop: 4,
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

const kwPill: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 6px",
  borderRadius: 3,
  backgroundColor: "#1f2a38",
  color: "#8a9aab",
};
