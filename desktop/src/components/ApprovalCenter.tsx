import { useEffect, useState } from "react";
import type { ApprovalRecord } from "../lib/desktop-client.ts";

const TERMINAL = new Set(["COMPLETE", "FAILED", "REVIEW_REQUIRED"]);

export function isTaskTerminal(state: string): boolean {
  return TERMINAL.has(state);
}

/**
 * Polls the server for pending guard approvals of the watched task and shows
 * them as a floating card stack (bottom-right). Approve/Deny resolve the
 * request; the guard inside Pi then lets the tool proceed or blocks it.
 */
export function ApprovalCenter({ taskId, baseUrl, token }: {
  taskId: string | null;
  baseUrl: string;
  token: string;
}) {
  const [approvals, setApprovals] = useState<readonly ApprovalRecord[]>([]);

  useEffect(() => {
    if (!taskId) {
      setApprovals([]);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${baseUrl}/tasks/${taskId}/approvals`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const j = (await r.json()) as { approvals: ApprovalRecord[] };
        if (alive) setApprovals(j.approvals ?? []);
      } catch {}
    };
    void poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [taskId, baseUrl, token]);

  async function decide(requestId: string, decision: "approve" | "deny", always = false) {
    try {
      const r = await fetch(`${baseUrl}/tasks/${taskId}/approvals/${requestId}/${decision}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: always ? JSON.stringify({ always: true }) : undefined,
      });
      if (!r.ok) return; // failed — keep the card so the user can retry
      setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    } catch {}
  }

  if (!approvals.length) return null;

  return (
    <div style={stackStyle}>
      {approvals.map((a) => (
        <div key={a.requestId} style={cardStyle}>
          <div style={titleStyle}>⚠ {a.title || "Approval required"}</div>
          <pre style={msgStyle}>{a.message}</pre>
          <div style={btnRow}>
            <button onClick={() => decide(a.requestId, "deny")} style={denyBtn}>Deny</button>
            <button onClick={() => decide(a.requestId, "approve", true)} style={alwaysBtn} title="Approve and remember — this command won't ask again">Always</button>
            <button onClick={() => decide(a.requestId, "approve")} style={approveBtn}>Approve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const stackStyle = {
  position: "fixed" as const,
  right: 16,
  bottom: 16,
  display: "flex",
  flexDirection: "column" as const,
  gap: 10,
  zIndex: 2000,
  maxWidth: 420,
  width: "90%",
};

const cardStyle = {
  backgroundColor: "var(--bg-secondary)",
  border: "1px solid var(--accent)",
  borderRadius: 8,
  padding: "12px 14px",
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
};

const titleStyle = { fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 6 };

const msgStyle = {
  fontSize: 11,
  color: "var(--text-muted)",
  backgroundColor: "var(--bg)",
  padding: 8,
  borderRadius: 4,
  border: "1px solid var(--border)",
  margin: "0 0 10px",
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-all" as const,
  maxHeight: 160,
  overflow: "auto" as const,
};

const btnRow = { display: "flex", justifyContent: "flex-end", gap: 8 };

const denyBtn = {
  padding: "6px 16px",
  borderRadius: 5,
  border: "1px solid var(--red)",
  backgroundColor: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: 13,
};

const alwaysBtn = {
  padding: "6px 16px",
  borderRadius: 5,
  border: "1px solid var(--border-strong)",
  backgroundColor: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: 13,
};

const approveBtn = {
  padding: "6px 16px",
  borderRadius: 5,
  border: "none",
  backgroundColor: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};
