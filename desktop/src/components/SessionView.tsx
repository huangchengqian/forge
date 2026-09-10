import { useEffect, useState } from "react";
import { store } from "../lib/store.ts";
import { fetchConfig } from "../lib/api.ts";
import { Markdown } from "./Markdown.tsx";
import type { ProviderConfig } from "../types.ts";

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
    <div className="card" style={{ borderColor: last.passed ? "color-mix(in srgb, var(--green) 40%, var(--border))" : "color-mix(in srgb, var(--red) 40%, var(--border))" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        Verification
      </div>
      {verification.map((v, i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, padding: "2px 0" }}>
          <span style={{ color: v.passed ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
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

/** Shared visual language for session-level notices. */
function Notice({ tone, icon, children }: { tone: "info" | "ok" | "warn"; icon: string; children: React.ReactNode }) {
  const color = tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--yellow)" : "var(--accent)";
  return (
    <div
      style={{
        margin: "10px 0",
        padding: "8px 12px",
        border: `1px solid color-mix(in srgb, ${color} 45%, var(--border))`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        color: "var(--text-secondary)",
        fontSize: 12.5,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
      }}
    >
      {icon} {children}
    </div>
  );
}

function CompactionNotice() {
  const compaction = store((s) => s.conversation.compaction);
  if (!compaction) return null;
  return (
    <Notice tone="info" icon="✦">
      Context compacted ({compaction.mode}) — older history was summarized into a
      checkpoint. The model's view of the conversation changed; behaviour may differ slightly.
    </Notice>
  );
}

function ResumedNotice() {
  const resumed = store((s) => s.conversation.resumed);
  if (!resumed) return null;
  return (
    <Notice tone="ok" icon="↻">
      Resumed — recovered {resumed.messagesRecovered} message
      {resumed.messagesRecovered === 1 ? "" : "s"} from the event log.
    </Notice>
  );
}

function StuckWarning() {
  const stuck = store((s) => s.conversation.stuck);
  if (!stuck) return null;
  return (
    <Notice tone="warn" icon="⚠">
      Stuck: {stuck.pattern} ×{stuck.repetitions} — the session is being terminated to protect your budget.
    </Notice>
  );
}

/** Empty-state: a session with no conversation output at all. */
function EmptyConversation() {
  const conversation = store((s) => s.conversation);
  if (conversation.messages.length > 0 || conversation.toolCalls.length > 0) return null;
  return (
    <div style={{ margin: "48px 0", color: "var(--text-muted)", fontSize: 13.5, textAlign: "center" }}>
      <div style={{ fontSize: 26, marginBottom: 10, opacity: 0.5 }}>◌</div>
      No messages yet — the agent hasn't produced any output for this session.
    </div>
  );
}

export function SessionView({ sessionId, goal, status, failureReason, modelId, trustLevel }: {
  sessionId: string;
  goal: string;
  status: string;
  failureReason: string | null;
  modelId: string;
  trustLevel: string;
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
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const running = status === "running";
  const resumable = status === "failed" || status === "cancelled";
  // MODEL_CHANGED events override the session's original model in the UI.
  const effectiveModelId = conversation.modelId ?? modelId;

  useEffect(() => {
    void fetchConfig()
      .then((cfg) => setProviders(cfg.providers))
      .catch(() => {});
  }, []);

  const onModelSwitch = async (providerId: string) => {
    if (!providerId || providerId === effectiveModelId) return;
    try {
      const { switchModel } = await import("../lib/api.ts");
      await switchModel(sessionId, providerId);
    } catch (err) {
      console.error("model switch failed:", err);
    }
  };

  // One send path for all states: running steers the live loop, a completed
  // session continues as a follow-up (prompt = the message), and
  // failed/cancelled retries (message optional — empty retries the goal).
  const send = async () => {
    const text = steerInput.trim();
    if (running) {
      if (!text) return;
      await steer(text);
      setSteerInput("");
      return;
    }
    if (status === "completed") {
      if (!text) return;
      await resume(text);
      setSteerInput("");
      return;
    }
    await resume(text || undefined);
    setSteerInput("");
  };
  const canSend = running || status === "completed" ? !!steerInput.trim() : true;

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

      <div className="conversation-scroll">
        <div className="conversation-canvas">
          <ResumedNotice />
          <EmptyConversation />
          {conversation.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="message message-user">
                <div className="message-user-body">{m.text}</div>
              </div>
            ) : (
              <div key={i} className="message message-agent">
                <div className="role-label">Agent</div>
                <div className="md">
                  <Markdown text={m.text} />
                </div>
              </div>
            ),
          )}

          {conversation.toolCalls.map((call) => (
            <ToolRow key={call.toolCallId} call={call} />
          ))}

          <CompactionNotice />
          <VerificationPanel />
          <StuckWarning />

          {failureReason && (
            <Notice tone="warn" icon="✕">
              Session failed: {failureReason}
            </Notice>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {diffText !== null && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "10px 28px", maxHeight: 200, overflowY: "auto" }}>
          <pre style={{ fontSize: 11.5, color: "var(--text-secondary)", whiteSpace: "pre-wrap", margin: 0 }}>{diffText}</pre>
        </div>
      )}

      <div className="conversation-composer-wrap">
        <div className="conversation-composer">
          <div className="composer-box" style={{ padding: "10px 12px 8px" }}>
            <textarea
              className="composer-ta"
              rows={2}
              placeholder={
                running
                  ? "Steer the agent at the next turn boundary…  (Enter to send)"
                  : status === "completed"
                    ? "Reply to continue this conversation…  (Enter to send)"
                    : "Describe what to change, or press Enter to retry the task…"
              }
              disabled={!running && !resumable && status !== "completed"}
              value={steerInput}
              onChange={(e) => setSteerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) void send();
                }
              }}
            />
            <div className="composer-actions" style={{ justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  className="composer-model-select"
                  value={providers.some((p) => p.modelId === effectiveModelId)
                    ? providers.find((p) => p.modelId === effectiveModelId)!.id
                    : ""}
                  onChange={(e) => void onModelSwitch(e.target.value)}
                  title="Model subscription — switching takes effect at the next turn boundary"
                >
                  {!providers.some((p) => p.modelId === effectiveModelId) && (
                    <option value="">{effectiveModelId || "no model"}</option>
                  )}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.modelId}
                    </option>
                  ))}
                </select>
                <span className="chip" title="completion verification level for this session">
                  trust: {trustLevel}
                </span>
                {!connected && (
                  <span className="chip" title="live event stream reconnecting…">
                    <span className="dot" style={{ background: "var(--yellow)" }} />
                    reconnecting
                  </span>
                )}
              </div>
              <button
                className="btn btn-primary btn-small"
                onClick={() => void send()}
                disabled={!canSend}
              >
                {running ? "Send ↵" : status === "completed" ? "Send ↵" : "Retry ↵"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
