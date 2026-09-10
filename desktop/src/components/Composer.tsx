import { useEffect, useRef, useState } from "react";
import { store } from "../lib/store.ts";
import { fetchConfig } from "../lib/api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { ProviderConfig, ThinkingLevel, TrustLevel } from "../types.ts";

/** Parse the compact criteria syntax: "file_exists:hello.txt" or
 * "file_contains:hello.txt:export" (kind:path[:pattern]). Empty → none. */
function parseCriteria(input: string): Array<{ kind: string; [k: string]: unknown }> {
  const line = input.trim();
  if (!line) return [];
  const parts = line.split(":").map((s) => s.trim());
  if (parts[0] === "file_exists" && parts[1]) return [{ kind: "file_exists", path: parts[1] }];
  if (parts[0] === "file_contains" && parts[1] && parts[2])
    return [{ kind: "file_contains", path: parts[1], pattern: parts[2] }];
  if (parts[0] === "command_exit_zero" && parts[1]) return [{ kind: "command_exit_zero", command: parts[1] }];
  return [];
}

const SUGGESTIONS = [
  "Create hello.ts exporting a hello() function",
  "Write unit tests for the existing code",
  "Refactor the messiest file in this repo",
  "Explain what this project does",
];

export function Composer({ projectId }: { projectId?: string | null }) {
  const createSession = store((s) => s.createSession);
  const loading = store((s) => s.loading);
  const error = store((s) => s.error);
  const [goal, setGoal] = useState("");
  const [trust, setTrust] = useState<TrustLevel>("medium");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [criteriaLine, setCriteriaLine] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  /** Thinking levels each subscription's model supports, per the server. */
  const [capabilities, setCapabilities] = useState<Record<string, ThinkingLevel[]>>({});
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void fetchConfig().then((cfg) => {
      setProviders(cfg.providers);
      setProviderId(cfg.defaultProviderId || cfg.providers[0]?.id || null);
      setCapabilities(cfg.modelCapabilities ?? {});
    }).catch(() => {});
  }, []);

  // Until the server tells us otherwise, assume no reasoning support — the
  // picker then says so instead of offering levels that would do nothing.
  const thinkingLevels = (providerId ? capabilities[providerId] : undefined) ?? ["off"];

  // Grow with the content instead of reserving three fixed rows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [goal]);

  const submit = () => {
    if (!goal.trim() || loading) return;
    void createSession({
      goal: goal.trim(),
      ...(projectId ? { projectId } : {}),
      ...(providerId ? { providerId } : {}),
      trustLevel: trust,
      thinkingLevel: thinking,
      ...(trust === "high" ? { criteria: parseCriteria(criteriaLine) } : {}),
    });
    setGoal("");
    setCriteriaLine("");
  };

  return (
    <div className="landing-wrap">
      <div className="landing">
        <h1 className="landing-title">What should Forge do?</h1>
        <p className="landing-sub">
          The agent reads, writes and runs commands in your project. Completion is
          verified before it is called done.
        </p>

        <div className="composer-box">
          <textarea
            ref={taRef}
            className="composer-ta"
            placeholder="Describe the engineering task…"
            value={goal}
            rows={1}
            autoFocus
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-actions">
            <div className="composer-meta">
              <ModelPicker
                providers={providers}
                activeProviderId={providerId}
                onSelectModel={setProviderId}
                trustLevel={trust}
                onSelectTrust={setTrust}
                thinkingLevel={thinking}
                thinkingLevels={thinkingLevels}
                onSelectThinking={setThinking}
                placement="above"
              />
              {trust === "high" && (
                <input
                  className="criteria-input"
                  placeholder="验收标准，如 file_exists:hello.txt"
                  value={criteriaLine}
                  onChange={(e) => setCriteriaLine(e.target.value)}
                />
              )}
            </div>
            <button className="btn btn-primary btn-small" onClick={submit} disabled={!goal.trim() || loading}>
              {loading ? "Starting…" : "Start"}
              <span className="key-hint">↵</span>
            </button>
          </div>
        </div>

        {error && <div className="landing-error">{error}</div>}

        <div className="landing-suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="suggestion-chip"
              onClick={() => {
                setGoal(s);
                taRef.current?.focus();
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
