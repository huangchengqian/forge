import { store } from "../lib/store.ts";
import type { ApprovalRecordView } from "../types.ts";

export function ApprovalDialog({ request }: { request: ApprovalRecordView | null }) {
  const approve = store((s) => s.approve);
  const deny = store((s) => s.deny);
  if (!request) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          width: 460,
          maxWidth: "90vw",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
          Allow {request.toolName}?
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 14, wordBreak: "break-all" }}>
          {request.message}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={() => void deny(request.requestId)}>
            Deny
          </button>
          <button className="btn btn-primary" onClick={() => void approve(request.requestId)}>
            Approve
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10 }}>
          Unanswered requests are denied after 5 minutes.
        </div>
      </div>
    </div>
  );
}
