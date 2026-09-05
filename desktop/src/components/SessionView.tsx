import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskSession, MemoryItem, Plan } from "../shared/types.ts";
import type { EventEnvelope, DiffResult, ProviderConfig } from "../lib/desktop-client.ts";
import { fetchDiff, undoTask } from "../lib/desktop-client.ts";

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
  const streamEndRef = useRef<HTMLDivElement>(null);

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

  async function handleSwitch(providerId: string) {
    if (!onSwitchModel || switching || providerId === task.model.provider) return;
    setSwitching(true); setSendError(null);
    try { await onSwitchModel(providerId); }
    catch (err) { setSendError(err instanceof Error ? err.message : String(err)); }
    setSwitching(false);
  }

  const items = useMemo(() => toChat(liveEvents), [liveEvents]);

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={head}>
        <span style={headTitle}>{task.goal || "(untitled)"}</span>
        <span style={{ ...dot, background: stateColor(task.state) }} title={task.state} />
        {providers.length > 0 && (
          <select
            value={task.model.provider ?? ""}
            onChange={(e) => void handleSwitch(e.target.value)}
            disabled={switching || !onSwitchModel}
            title={switching ? "Switching…" : "Switch model for this session"}
            style={{ marginLeft: "auto", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", color: "var(--text)", fontSize: 12, maxWidth: 240 }}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{modelLabel(p.baseUrl)} · {p.modelId}</option>
            ))}
          </select>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 28px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 24 }}>
          {/* User message */}
          <div style={userBlock}>
            <div style={roleLabel}>User</div>
            <div style={userText}>{task.goal}</div>
          </div>

          {/* Plan (collapsible) */}
          {task.plan && task.plan.steps.length > 0 && (
            <div style={planCard}>
              <div onClick={() => setPlanOpen((v) => !v)} style={planHeader}>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{planOpen ? "▾" : "▸"}</span>
                <span style={planTitle}>Plan</span>
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
              return (
                <div key={i} style={agentBlock}>
                  <div style={roleLabel}>Agent</div>
                  <div style={agentText}>{it.text}</div>
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
                <div key={i} onClick={() => toggle(i)} style={toolRow}>
                  <span style={{ color: "var(--text-muted)", fontSize: 12, width: 16 }}>{open ? "▾" : "▸"}</span>
                  <span style={{ ...toolTag, background: toolColor(it.status) }}>{toolIcon(it.status)}</span>
                  <span style={toolSummary}>{it.summary}</span>
                  {open && <pre style={toolDetailPre}>{it.detail}</pre>}
                </div>
              );
            }
            return (
              <div key={i} style={statusRow}>
                <span style={{ color: toneColor(it.tone) }}>{it.text}</span>
              </div>
            );
          })}
          {items.length === 0 && !task.plan && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 24 }}>Waiting for the agent…</div>
          )}

          {/* Diff (only when changes exist) */}
          {diff && diff.kind !== "none" && (
            <div style={diffBlock}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Changed files</span>
                <button onClick={handleUndo} disabled={undoing} style={undoBtn}>{undoing ? "Restoring…" : "Undo"}</button>
              </div>
              {undoMsg && <div style={{ fontSize: 12, color: undoMsg.startsWith("Undone") ? "var(--green)" : "var(--red)", marginBottom: 6 }}>{undoMsg}</div>}
              {diff.kind === "git" ? (
                <pre style={diffPre}>{diff.diff.slice(0, 4000)}{diff.diff.length > 4000 ? "\n… (truncated)" : ""}</pre>
              ) : (
                <div>
                  {diff.files.map((f) => (
                    <div key={f.path} style={{ fontSize: 12, padding: "2px 0", color: "var(--text-secondary)", fontFamily: "monospace" }}>
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
          <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", gap: 10 }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
              placeholder="Reply / continue…"
              style={composerInput}
            />
            <button onClick={handleSend} disabled={!draft.trim() || sending} style={sendBtn}>
              {sending ? "…" : "Send"}
            </button>
          </div>
          {sendError && <div style={{ maxWidth: 720, margin: "8px auto 0", color: "var(--red)", fontSize: 12 }}>{sendError}</div>}
        </div>
      )}
    </div>
  );
}

function stateColor(s: string): string {
  return s === "COMPLETE" ? "var(--green)" : s === "FAILED" ? "var(--red)" : s === "REVIEW_REQUIRED" ? "var(--yellow)" : "var(--accent)";
}

/** Agent reasoning — collapsed by default, expand in place to inspect. */
function ThinkCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={thinkCard}>
      <div onClick={() => setOpen((v) => !v)} style={thinkHeader}>
        <span style={{ color: "var(--text-muted)", fontSize: 12, width: 16 }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>🤔</span>
        <span style={thinkTitle}>{open ? "Thought" : "Thinking…"}</span>
      </div>
      {open && (
        <div style={thinkBody}>
          {text.split("\n").filter(Boolean).map((line, i) => (
            <div key={i} style={{ padding: "2px 0", color: "var(--text-muted)", fontSize: 12.5, lineHeight: 1.6 }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Light-weight "✦ Used N memories" hint, expandable in place. */
function MemoryHint({ memories }: { memories: UsedMemoryEntry[] }) {  const [open, setOpen] = useState(false);
  return (
    <div style={memCard}>
      <div onClick={() => setOpen((v) => !v)} style={memHeader}>
        <span style={{ color: "var(--accent)", fontSize: 12, width: 16 }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--accent)", fontSize: 12.5, marginRight: 6 }}>✦</span>
        <span style={memTitle}>
          Used {memories.length} {memories.length === 1 ? "memory" : "memories"}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {memories.map((m, i) => (
            <div key={i} style={{ padding: "4px 0", fontSize: 12.5, lineHeight: 1.5, display: "flex", gap: 8 }}>
              <span style={{ ...memType, color: memoryTypeColor(m.type) }}>{m.type}</span>
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

const head = { display: "flex", alignItems: "center", gap: 10, padding: "14px 28px", borderBottom: "1px solid var(--border)" };
const headTitle = { flex: 1, fontSize: 15, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
const dot = { width: 8, height: 8, borderRadius: 99, display: "inline-block", flexShrink: 0 };
const roleLabel = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.5px" };
const userBlock = { marginBottom: 20 };
const userText = { fontSize: 15, color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-wrap" as const };
const agentBlock = { margin: "18px 0" };
const agentText = { fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.7, whiteSpace: "pre-wrap" as const };
const planCard = { backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", margin: "12px 0" };
const planHeader = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" };
const planTitle = { fontSize: 13, fontWeight: 600, color: "var(--text)" };
const memCard = { margin: "10px 0" };
const memHeader = { display: "flex", alignItems: "center", gap: 4, cursor: "pointer", padding: "2px 0" };
const memTitle = { fontSize: 12.5, color: "var(--text-muted)" };
const memType = { fontFamily: "monospace", fontSize: 11, flexShrink: 0, fontWeight: 600 };
const thinkCard = { margin: "6px 0", backgroundColor: "var(--bg)", border: "1px dashed var(--border)", borderRadius: 6, padding: "6px 10px" };
const thinkHeader = { display: "flex", alignItems: "center", gap: 4, cursor: "pointer", padding: "2px 0" };
const thinkTitle = { fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" };
const thinkBody = { marginTop: 4, paddingLeft: 20 };
const toolRow = { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, cursor: "pointer", flexWrap: "wrap" as const };
const toolTag = { width: 16, height: 16, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", flexShrink: 0 };
const toolSummary = { fontSize: 13, color: "var(--text-secondary)", fontFamily: "monospace" };
const toolDetailPre = { width: "100%", backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const, margin: "6px 0 0 24px" };
const statusRow = { padding: "3px 0", fontSize: 13 };
const diffBlock = { borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 };
const undoBtn = { padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border-strong)", backgroundColor: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 };
const diffPre = { backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, fontSize: 11.5, color: "var(--text-muted)", overflow: "auto" as const, maxHeight: 260, whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const, margin: 0 };
const composerInput = { flex: 1, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border-strong)", backgroundColor: "var(--bg-secondary)", color: "var(--text)", fontSize: 14, outline: "none" };
const sendBtn = { padding: "8px 20px", borderRadius: 8, border: "none", backgroundColor: "var(--accent)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" };
