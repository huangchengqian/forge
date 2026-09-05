import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskSession, MemoryItem, Plan } from "../shared/types.ts";
import type { EventEnvelope, DiffResult, ProviderConfig } from "../lib/desktop-client.ts";
import { fetchDiff, undoTask, cancelTask } from "../lib/desktop-client.ts";
import { isTaskTerminal } from "./ApprovalCenter.tsx";
import { Markdown } from "./Markdown.tsx";
import { DiffView } from "./DiffView.tsx";

type UsedMemoryEntry = { type: string; content: string; confidence: number };

type ChatItem =
  | { kind: "agent"; text: string }
  | { kind: "think"; text: string }
  | { kind: "tool"; name: string; detail: string; status: "running" | "done" | "error" | "pending"; summary: string }
  | { kind: "status"; text: string; tone: "info" | "ok" | "bad" }
  | { kind: "memory"; memories: UsedMemoryEntry[] };

const THINK_RE = /<\s*think\s*>([\s\S]*?)<\/\s*think\s*>/g;

/**
 * Split an assistant message into thinking segments and visible text. Models
 * like MiniMax/DeepSeek emit reasoning as a leading <think>...</think> block
 * inside the content stream; we render those as a collapsible card instead of
 * dumping them into the conversation as ordinary agent text.
 */
function splitThink(text: string): Array<{ kind: "think" | "agent"; text: string }> {
  const parts: Array<{ kind: "think" | "agent"; text: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  THINK_RE.lastIndex = 0;
  while ((m = THINK_RE.exec(text))) {
    const head = text.slice(last, m.index).trim();
    if (head) parts.push({ kind: "agent", text: head });
    const inner = (m[1] ?? "").trim();
    if (inner) parts.push({ kind: "think", text: inner });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) parts.push({ kind: "agent", text: tail });
  return parts.length > 0 ? parts : [{ kind: "agent", text: text.trim() }];
}

/** Convert the raw event stream (history + live) into conversation entries. */
function toChat(events: readonly EventEnvelope[]): ChatItem[] {
  const items: ChatItem[] = [];
  let agentBuf = "";
  let pendingTool: ChatItem | null = null;

  const flushAgent = () => {
    if (agentBuf.trim()) {
      for (const part of splitThink(agentBuf)) {
        items.push(part.kind === "think" ? { kind: "think", text: part.text } : { kind: "agent", text: part.text });
      }
      agentBuf = "";
    }
  };
  const flushTool = () => {
    if (pendingTool) { items.push(pendingTool); pendingTool = null; }
  };

  for (const e of events) {
    if (e.type === "AGENT_EVENT") {
      const pe = e.payload.piEvent as Record<string, any> | undefined;
      if (!pe) continue;
      if (pe.type === "message_update") {
        flushTool();
        const ame = pe.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") agentBuf += ame.delta;
      } else if (pe.type === "message_end") {
        // Authoritative final text replaces the accumulated deltas: some
        // providers stream CJK text with character reordering while the
        // final message is clean, so the visible text self-corrects here.
        flushTool();
        const msg = pe.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const text = msg.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
          if (text.length > 0) agentBuf = text;
        }
      } else if (pe.type === "tool_call") {
        flushAgent();
        pendingTool = { kind: "tool", name: String(pe.toolName ?? "tool"), summary: humanTool(pe.toolName, pe.input), detail: toolDetail(pe.toolName, pe.input), status: "pending" };
      } else if (pe.type === "tool_execution_start") {
        flushAgent();
        pendingTool = { kind: "tool", name: String(pe.toolName ?? "tool"), summary: humanTool(pe.toolName, pe.args), detail: toolDetail(pe.toolName, pe.args), status: "running" };
      } else if (pe.type === "tool_execution_end") {
        flushAgent();
        items.push({ kind: "tool", name: String(pe.toolName ?? "tool"), summary: humanTool(pe.toolName, pe.args), detail: toolResult(pe.result), status: pe.isError ? "error" : "done" });
      } else if (pe.type === "user_message") {
        flushAgent(); flushTool();
        items.push({ kind: "status", text: String(pe.text ?? ""), tone: "info" });
      } else if (pe.type === "turn_error") {
        flushAgent(); flushTool();
        items.push({ kind: "status", text: String(pe.error ?? "turn failed"), tone: "bad" });
      }
    } else if (e.type === "MEMORY_USED") {
      flushAgent(); flushTool();
      const mems = (e.payload.memories ?? []) as UsedMemoryEntry[];
      if (mems.length > 0) items.push({ kind: "memory", memories: mems });
    } else if (e.type === "STEP_STARTED") {
      flushAgent(); flushTool();
      items.push({ kind: "status", text: String(e.payload.intent ?? e.payload.stepId ?? "step"), tone: "info" });
    } else if (e.type === "OBSERVATION_CREATED") {
      flushAgent(); flushTool();
      const p = e.payload as { result?: string; failureReason?: string };
      const ok = p.result === "PASS";
      items.push({ kind: "status", text: ok ? "✓ Verified" : `✗ ${p.failureReason ?? "verification failed"}`, tone: ok ? "ok" : "bad" });
    } else if (e.type === "FIX_STARTED") {
      flushAgent(); flushTool();
      items.push({ kind: "status", text: "Fixing…", tone: "info" });
    } else if (e.type === "TASK_COMPLETED") {
      flushAgent(); flushTool();
      items.push({ kind: "status", text: "Completed", tone: "ok" });
    } else if (e.type === "TASK_FAILED") {
      flushAgent(); flushTool();
      items.push({ kind: "status", text: "Failed", tone: "bad" });
    }
  }
  flushAgent(); flushTool();
  return items;
}

type Usage = { input: number; output: number; cost: number };

/** Aggregate token usage across assistant messages in the event stream. */
function sumUsage(events: readonly EventEnvelope[]): Usage {
  const total: Usage = { input: 0, output: 0, cost: 0 };
  for (const e of events) {
    if (e.type !== "AGENT_EVENT") continue;
    const pe = e.payload.piEvent as Record<string, any> | undefined;
    if (pe?.type !== "message_end") continue;
    const msg = pe.message as { role?: string; usage?: Record<string, any> } | undefined;
    if (msg?.role !== "assistant" || !msg.usage || typeof msg.usage !== "object") continue;
    const u = msg.usage;
    total.input += num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
    total.output += num(u.output);
    total.cost += num(u.cost?.total);
  }
  return total;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function humanTool(name: string | undefined, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "bash": { const first = (String(o.command ?? "").split("\n")[0] ?? ""); return "Running " + first.slice(0, 80); }
    case "write": return "Writing " + String(o.path ?? "");
    case "edit": return "Editing " + String(o.path ?? "");
    case "read": return "Reading " + String(o.path ?? "");
    case "grep": return "Searching " + String(o.pattern ?? "");
    case "ls": return "Listing " + (String(o.path ?? "") || "directory");
    case "find": return "Finding " + String(o.pattern ?? "");
    default: return name ?? "tool";
  }
}

function toolDetail(name: string | undefined, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (name === "bash") return "$ " + String(o.command ?? "");
  return JSON.stringify(o, null, 2).slice(0, 1000);
}

function toolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result.slice(0, 1000);
  return JSON.stringify(result).slice(0, 1000);
}

function modelLabel(baseUrl: string): string {
  const known: Record<string, string> = {
    "https://api.anthropic.com": "Anthropic",
    "https://api.minimax.io/anthropic": "MiniMax",
    "https://api.minimaxi.com/anthropic": "MiniMax CN",
    "https://api.kimi.com/coding": "Kimi",
    "https://api.openai.com/v1": "OpenAI",
    "https://api.deepseek.com": "DeepSeek",
    "https://api.moonshot.ai/v1": "Moonshot",
    "https://api.groq.com/openai/v1": "Groq",
  };
  return known[baseUrl] ?? "Custom";
}

export function SessionView({ task, memory, liveEvents, providers, onSend, onSwitchModel }: {
  task: TaskSession;
  memory: readonly MemoryItem[];
  liveEvents: readonly EventEnvelope[];
  providers: readonly ProviderConfig[];
  onSend?: (message: string) => Promise<void>;
  onSwitchModel?: (providerId: string) => Promise<void>;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [planOpen, setPlanOpen] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveEvents.length]);

  useEffect(() => {
    let alive = true;
    setDiff(null); setUndoMsg(null);
    void fetchDiff(task.id).then((d) => { if (alive) setDiff(d); }).catch(() => {});
    return () => { alive = false; };
  }, [task.id]);

  async function handleUndo() {
    if (undoing) return;
    setUndoing(true); setUndoMsg(null);
    try {
      const r = await undoTask(task.id);
      setUndoMsg(`Undone — ${r.restored} file(s) restored`);
      setDiff(await fetchDiff(task.id));
    } catch (err) {
      setUndoMsg(err instanceof Error ? err.message : "Undo failed");
    }
    setUndoing(false);
  }

  async function handleSend() {
    const m = draft.trim();
    if (!m || sending || !onSend) return;
    setSending(true); setSendError(null);
    try { await onSend(m); setDraft(""); }
    catch (err) { setSendError(err instanceof Error ? err.message : String(err)); }
    setSending(false);
  }

  async function handleStop() {
    if (stopping) return;
    setStopping(true); setSendError(null);
    try { await cancelTask(task.id); }
    catch (err) { setSendError(err instanceof Error ? err.message : String(err)); }
    setStopping(false);
  }

  async function handleSwitch(providerId: string) {
    if (!onSwitchModel || switching || providerId === task.model.provider) return;
    setSwitching(true); setSendError(null);
    try { await onSwitchModel(providerId); }
    catch (err) { setSendError(err instanceof Error ? err.message : String(err)); }
    setSwitching(false);
  }

  /** Auto-grow the reply textarea with content (1..10 rows). */
  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }

  const items = useMemo(() => toChat(liveEvents), [liveEvents]);
  const usage = useMemo(() => sumUsage(liveEvents), [liveEvents]);
  const streaming = useMemo(() => {
    const last = liveEvents[liveEvents.length - 1];
    if (!last || last.type !== "AGENT_EVENT") return false;
    const pe = last.payload.piEvent as Record<string, any> | undefined;
    if (pe?.type !== "message_update") return false;
    return (pe.assistantMessageEvent as { type?: string } | undefined)?.type === "text_delta";
  }, [liveEvents]);

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  const active = !isTaskTerminal(task.state);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="session-head">
        <span className="session-head-title">{task.goal || "(untitled)"}</span>
        <span className="chip" title={task.state}>
          <span className="dot" style={{ background: stateColor(task.state) }} />
          {stateLabel(task.state)}
        </span>
        {usage.input + usage.output > 0 && (
          <span className="chip" title={`${fmtTokens(usage.input)} input · ${fmtTokens(usage.output)} output tokens`}>
            {fmtTokens(usage.input)} → {fmtTokens(usage.output)} tok
            {usage.cost > 0.0005 && ` · $${usage.cost.toFixed(2)}`}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 28px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 24 }}>
          {/* User message */}
          <div style={{ marginBottom: 20, marginTop: 18 }}>
            <div className="role-label">User</div>
            <div style={{ fontSize: 15, color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{task.goal}</div>
          </div>

          {/* Plan (collapsible) */}
          {task.plan && task.plan.steps.length > 0 && (
            <div className="card">
              <div onClick={() => setPlanOpen((v) => !v)} className="collapsible-header">
                <span className="caret">{planOpen ? "▾" : "▸"}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Plan</span>
                <PlanProgress plan={task.plan} />
              </div>
              {planOpen && (
                <div style={{ marginTop: 6 }}>
                  {task.plan.steps.map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}>
                      <span style={{ color: stepColor(s.status) }}>{stepIcon(s.status)}</span>
                      <span style={{ color: "var(--text-secondary)" }}>{s.intent}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Agent activity */}
          {items.map((it, i) => {
            if (it.kind === "agent") {
              const isLast = streaming && i === items.length - 1;
              return (
                <div key={i} style={{ margin: "18px 0" }}>
                  <div className="role-label">Agent</div>
                  <div style={isLast ? { display: "inline" } : undefined}>
                    <Markdown text={it.text} />
                    {isLast && <span className="stream-caret" />}
                  </div>
                </div>
              );
            }
            if (it.kind === "think") {
              return <ThinkCard key={i} text={it.text} />;
            }
            if (it.kind === "memory") {
              return <MemoryHint key={i} memories={it.memories} />;
            }
            if (it.kind === "tool") {
              const open = expanded.has(i);
              return (
                <div key={i} onClick={() => toggle(i)} className="tool-row">
                  <span className="caret">{open ? "▾" : "▸"}</span>
                  <span style={{ ...toolTag, background: toolColor(it.status) }}>{toolIcon(it.status)}</span>
                  <span className="tool-summary">{it.summary}</span>
                  {open && <pre style={toolDetailPre}>{it.detail}</pre>}
                </div>
              );
            }
            return (
              <div key={i} style={{ padding: "3px 0", fontSize: 13 }}>
                <span style={{ color: toneColor(it.tone) }}>{it.text}</span>
              </div>
            );
          })}
          {items.length === 0 && !task.plan && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 24 }}>Waiting for the agent…</div>
          )}

          {/* Diff (only when changes exist) */}
          {diff && diff.kind !== "none" && (
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Changed files</span>
                <button onClick={handleUndo} disabled={undoing} className="btn btn-ghost btn-small">{undoing ? "Restoring…" : "Undo"}</button>
              </div>
              {undoMsg && <div style={{ fontSize: 12, color: undoMsg.startsWith("Undone") ? "var(--green)" : "var(--red)", marginBottom: 6 }}>{undoMsg}</div>}
              {diff.kind === "git" ? (
                diff.diff.length > 200_000
                  ? <pre className="tool-detail">{diff.diff.slice(0, 200_000)}{"\n… (truncated)"}</pre>
                  : <DiffView diff={diff.diff} />
              ) : (
                <div>
                  {diff.files.map((f) => (
                    <div key={f.path} style={{ fontSize: 12, padding: "2px 0", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                      <span style={{ color: "var(--green)", marginRight: 6 }}>{f.backup ? "M" : "+"}</span>{f.path}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div ref={streamEndRef} />
        </div>
      </div>

      {onSend && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "12px 28px 16px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <div className="composer-box">
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); autoGrow(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Reply / continue…  (Enter to send, Shift+Enter for newline)"
                rows={1}
                className="composer-ta"
              />
              <div className="composer-actions">
                {providers.length > 0 && (
                  <select
                    value={task.model.provider ?? ""}
                    onChange={(e) => void handleSwitch(e.target.value)}
                    disabled={switching || !onSwitchModel}
                    title={switching ? "Switching…" : "Switch model for this session"}
                    className="composer-model-select">
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{modelLabel(p.baseUrl)} · {p.modelId}</option>
                    ))}
                  </select>
                )}
                {active && (
                  <button onClick={handleStop} disabled={stopping} className="btn btn-danger btn-small" title="Stop the running task">
                    {stopping ? "Stopping…" : "■ Stop"}
                  </button>
                )}
                <button onClick={handleSend} disabled={!draft.trim() || sending} className="btn btn-primary btn-small" style={{ marginLeft: "auto" }}>
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </div>
            {sendError && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>{sendError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanProgress({ plan }: { plan: Plan }) {
  const done = plan.steps.filter((s) => s.status === "verified" || s.status === "cancelled").length;
  return (
    <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
      {done}/{plan.steps.length} steps
    </span>
  );
}

function stateLabel(s: string): string {
  const map: Record<string, string> = {
    READY: "Ready", UNDERSTAND: "Understanding", PLAN: "Planning", EXECUTE: "Executing",
    OBSERVE: "Verifying", FIX: "Fixing", EVALUATE: "Evaluating", COMPLETE: "Completed",
    REVIEW_REQUIRED: "Review required", FAILED: "Failed",
  };
  return map[s] ?? s;
}

function stateColor(s: string): string {
  return s === "COMPLETE" ? "var(--green)" : s === "FAILED" ? "var(--red)" : s === "REVIEW_REQUIRED" ? "var(--yellow)" : "var(--accent)";
}

/** Agent reasoning — collapsed by default, expand in place to inspect. */
function ThinkCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "6px 0", border: "1px dashed var(--border)", borderRadius: 6, padding: "6px 10px" }}>
      <div onClick={() => setOpen((v) => !v)} className="collapsible-header">
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" }}>{open ? "Thought" : "Thinking…"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 4, paddingLeft: 20 }}>
          {text.split("\n").filter(Boolean).map((line, i) => (
            <div key={i} style={{ padding: "2px 0", color: "var(--text-muted)", fontSize: 12.5, lineHeight: 1.6 }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Light-weight "✦ Used N memories" hint, expandable in place. */
function MemoryHint({ memories }: { memories: UsedMemoryEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "10px 0" }}>
      <div onClick={() => setOpen((v) => !v)} className="collapsible-header">
        <span className="caret" style={{ color: "var(--accent)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--accent)", fontSize: 12.5, marginRight: 6 }}>✦</span>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Used {memories.length} {memories.length === 1 ? "memory" : "memories"}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {memories.map((m, i) => (
            <div key={i} style={{ padding: "4px 0", fontSize: 12.5, lineHeight: 1.5, display: "flex", gap: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0, fontWeight: 600, color: memoryTypeColor(m.type) }}>{m.type}</span>
              <span style={{ color: "var(--text-secondary)", flex: 1 }}>{m.content}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>conf {m.confidence}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function memoryTypeColor(t: string): string {
  return t === "SOLUTION" ? "var(--green)" : t === "FAILURE_PATTERN" ? "var(--red)" : t === "DECISION" ? "var(--yellow)" : "var(--accent)";
}
function stepColor(s: string): string {
  return s === "verified" ? "var(--green)" : s === "failed" ? "var(--red)" : s === "running" ? "var(--accent)" : "var(--text-muted)";
}
function stepIcon(s: string): string {
  return s === "verified" ? "✓" : s === "failed" ? "✗" : s === "running" ? "…" : "○";
}
function toolColor(s: string): string {
  return s === "error" ? "var(--red)" : s === "done" ? "var(--green)" : s === "running" ? "var(--accent)" : "var(--text-muted)";
}
function toolIcon(s: string): string {
  return s === "error" ? "✗" : s === "done" ? "✓" : s === "running" ? "…" : "•";
}
function toneColor(t: string): string {
  return t === "ok" ? "var(--green)" : t === "bad" ? "var(--red)" : "var(--text-muted)";
}

const toolTag = { width: 16, height: 16, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", flexShrink: 0 };
const toolDetailPre = { width: "100%", backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)", whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const, margin: "6px 0 0 24px" };
