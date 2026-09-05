import { useEffect, useState } from "react";
import type { ApprovalRecord } from "../lib/desktop-client.ts";

const TERMINAL = new Set(["COMPLETE", "FAILED", "REVIEW_REQUIRED", "CANCELLED"]);

export function isTaskTerminal(state: string): boolean {
  return TERMINAL.has(state);
}

/** Poll the server for pending guard approvals of one task. */
export function useApprovals(taskId: string | null, baseUrl: string, token: string): {
  approvals: readonly ApprovalRecord[];
  decide: (requestId: string, decision: "approve" | "deny", always?: boolean) => Promise<void>;
} {
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

  return { approvals, decide };
}

/** One approval card — used inline in the conversation and in the floating stack. */
export function ApprovalCard({ approval, onDecide }: {
  approval: ApprovalRecord;
  onDecide: (requestId: string, decision: "approve" | "deny", always?: boolean) => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>⚠ {approval.title || "Approval required"}</div>
      <pre style={msgStyle}>{approval.message}</pre>
      <div style={btnRow}>
        <button onClick={() => onDecide(approval.requestId, "deny")} className="btn btn-danger btn-small">Deny</button>
        <button onClick={() => onDecide(approval.requestId, "approve", true)} className="btn btn-ghost btn-small" title="Approve and remember — this command won't ask again">Always</button>
        <button onClick={() => onDecide(approval.requestId, "approve")} className="btn btn-primary btn-small">Approve</button>
      </div>
    </div>
  );
}

/**
 * Floating card stack (bottom-right) for approvals of the watched task. Used
 * when no conversation view is open; with a session open, cards render inline
 * above the composer instead.
 */
export function ApprovalCenter({ taskId, baseUrl, token, hidden }: {
  taskId: string | null;
  baseUrl: string;
  token: string;
  /** The session view renders the same cards inline; suppress the stack there. */
  hidden?: boolean;
}) {
  const { approvals, decide } = useApprovals(taskId, baseUrl, token);

  if (hidden || !approvals.length) return null;

  return (
    <div style={stackStyle}>
      {approvals.map((a) => (
        <ApprovalCard key={a.requestId} approval={a} onDecide={decide} />
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


