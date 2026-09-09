import { useState } from "react";
import { store } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";

/** Tool call row with expandable args/result. */
function ToolRow({ call }: { call: { toolCallId: string; toolName: string; args: unknown; result?: unknown; isError?: boolean; running: boolean } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-row" onClick={() => setOpen((v) => !v)}>
      <span className="caret">{open ? "▾" : "▸"}</span>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 4,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          color: "#fff",
          background: call.running
            ? "var(--yellow)"
            : call.isError
              ? "var(--red)"
              : "var(--green)",
          flexShrink: 0,
        }}
      >
        {call.running ? "…" : call.isError ? "✕" : "✓"}
      </span>
      <span className="tool-summary">
        {call.toolName} {JSON.stringify(call.args).slice(0, 90)}
      </span>
      {open && (
        <pre className="tool-detail">
          {JSON.stringify({ args: call.args, result: call.result }, null, 2).slice(0, 4000)}
        </pre>
      )}
    </div>
  );
}

/** Criteria pass/fail feed — the VerificationPanel. */
function VerificationPanel() {
  const verification = store((s) => s.conversation.verification);
  if (verification.length === 0) return null;
  const last = verification[verification.length - 1]!;
  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
        Verification
      </div>
      {verification.map((v, i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, padding: "2px 0" }}>
          <span style={{ color: v.passed ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
            {v.passed ? "PASS" : "FAIL"}
          </span>
          <span style={{ color: "var(--text-secondary)" }}>
            round {v.round}
            {v.reason ? ` — ${v.reason}` : ""}
          </span>
        </div>
      ))}
      {!last.passed && (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
          Agent is being steered back to fix the failure…
        </div>
      )}
    </div>
  );
}

function CostGauge({ spent, budget }: { spent: number; budget: number | null }) {
  if (spent <= 0) return null;
  return (
    <span className="chip" title="session cost">
      ${spent.toFixed(2)}
      {budget !== null ? ` / $${budget}` : ""}
    </span>
  );
}

function StuckWarning() {
  const stuck = store((s) => s.conversation.stuck);
  if (!stuck) return null;
  return (
    <div
      style={{
        margin: "10px 0",
        padding: "8px 12px",
        border: "1px solid var(--yellow)",
        borderRadius: 8,
        color: "var(--yellow)",
        fontSize: 12.5,
      }}
    >
      ⚠ Stuck: {stuck.pattern} ×{stuck.repetitions} — the session is being terminated to protect your budget.
    </div>
  );
}

export function SessionView({ sessionId, goal, status, failureReason }: {
  sessionId: string;
  goal: string;
  status: string;
  failureReason: string | null;
}) {
  const conversation = store((s) => s.conversation);
  const connected = store((s) => s.connected);
  const costSpent = store((s) => s.conversation.costSpent);
  const costBudget = store((s) => s.conversation.costBudget);
  const steer = store((s) => s.steer);
  const abort = store((s) => s.abort);
  const resume = store((s) => s.resume);
  const showDiff = store((s) => s.showDiff);
  const undo = store((s) => s.undo);
  const diffText = store((s) => s.diffText);
  const [steerInput, setSteerInput] = useState("");
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeMessage, setResumeMessage] = useState("");
  const running = status === "running";
  const resumable = status === "failed" || status === "cancelled";

  const endRef = (el: HTMLDivElement | null) => {
    el?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="session-head">
        <span className="session-head-title" title={goal}>{goal}</span>
        <span className="chip">
          <span
            className="dot"
            style={{
              background:
                status === "completed"
                  ? "var(--green)"
                  : status === "failed"
                    ? "var(--red)"
                    : status === "cancelled"
                      ? "var(--text-muted)"
                      : "var(--accent)",
            }}
          />
          {status}
        </span>
        <CostGauge spent={costSpent} budget={costBudget} />
        {running && (
          <button className="btn btn-danger btn-small" onClick={() => void abort()}>
            ■ Stop
          </button>
        )}
        {resumable && (
          <button
            className="btn btn-primary btn-small"
            onClick={() => {
              setResumeMessage("");
              setResumeOpen(true);
            }}
            title="Resume this session from its event log"
          >
            ↻ Resume
          </button>
        )}
        <button className="btn btn-ghost btn-small" onClick={() => void showDiff()}>Diff</button>
        <button className="btn btn-ghost btn-small" onClick={() => void undo()}>Undo</button>
      </div>

      {resumeOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setResumeOpen(false);
          }}
        >
          <div className="modal">
            <h3 style={{ marginTop: 0 }}>Resume session</h3>
            <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
              The agent will continue from its event log. Optionally add a
              steering instruction (e.g. "also fix the failing tests").
            </p>
            <textarea
              className="composer-textarea"
              placeholder="Optional: e.g. also fix the failing tests"
              value={resumeMessage}
              onChange={(e) => setResumeMessage(e.target.value)}
              rows={3}
              style={{ width: "100%", marginBottom: 12 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                className="btn btn-ghost btn-small"
                onClick={() => setResumeOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-small"
                onClick={async () => {
                  await resume(resumeMessage.trim() || undefined);
                  setResumeOpen(false);
                }}
              >
                Resume
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 28px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 24 }}>
          {conversation.messages.map((m, i) => (
            <div key={i} style={{ margin: "16px 0" }}>
              <div className="role-label">{m.role === "user" ? "You" : "Agent"}</div>
              <div style={{ color: m.role === "user" ? "var(--text)" : undefined }}>
                <Markdown text={m.text} />
              </div>
            </div>
          ))}

          {conversation.toolCalls.map((call) => (
            <ToolRow key={call.toolCallId} call={call} />
          ))}

          <VerificationPanel />
          <StuckWarning />

          {failureReason && (
            <div style={{ color: "var(--red)", fontSize: 12.5, margin: "10px 0" }}>
              Session failed: {failureReason}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {diffText !== null && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "10px 28px", maxHeight: 200, overflowY: "auto" }}>
          <pre style={{ fontSize: 11.5, color: "var(--text-secondary)", whiteSpace: "pre-wrap", margin: 0 }}>{diffText}</pre>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border)", padding: "12px 28px 16px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span
            className="chip"
            title={connected ? "live event stream connected" : "reconnecting…"}
          >
            <span
              className="dot"
              style={{ background: connected ? "var(--green)" : "var(--yellow)" }}
            />
            {connected ? "live" : "reconnecting"}
          </span>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={running ? "Steer: type to redirect the agent at the next turn boundary…" : "Session ended"}
            disabled={!running}
            value={steerInput}
            onChange={(e) => setSteerInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && steerInput.trim()) {
                void steer(steerInput.trim());
                setSteerInput("");
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
