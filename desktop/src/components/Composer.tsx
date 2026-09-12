import { useEffect, useRef, useState } from "react";
import { store } from "../lib/store.ts";
import { useModelCatalog } from "../lib/catalog.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { ApprovalMode, ThinkingLevel, TrustLevel } from "../types.ts";

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

export function Composer({ projectId }: { projectId?: string | null }) {
  const createSession = store((s) => s.createSession);
  const loading = store((s) => s.loading);
  const error = store((s) => s.error);
  const [goal, setGoal] = useState("");
  const [trust, setTrust] = useState<TrustLevel>("medium");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [criteriaLine, setCriteriaLine] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("default");
  // Turn budget: after the cost budget was retired this is the only "runaway"
  // bound, and it used to have no UI entry at all (AGENTS.md Rule 9.2: a
  // capability without a UI entry point does not exist for the user).
  const { providers, defaultProviderId, capabilities } = useModelCatalog();
  const [providerId, setProviderId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Default the picker to the configured default subscription once the
  // catalog arrives (and keep a manual choice if the user already made one).
  useEffect(() => {
    if (providerId !== null || providers.length === 0) return;
    setProviderId(defaultProviderId || providers[0]?.id || null);
  }, [providers, defaultProviderId, providerId]);

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
      approvalMode,
      ...(trust === "high" ? { criteria: parseCriteria(criteriaLine) } : {}),
    });
    setGoal("");
    setCriteriaLine("");
  };

  return (
    <div className="landing-wrap">
      <div className="landing">
        <h1 className="landing-title">What should Forge do?</h1>
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
                approvalMode={approvalMode}
                onSelectApprovalMode={setApprovalMode}
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

      </div>
    </div>
  );
}
