import { useEffect, useState } from "react";
import { store } from "../lib/store.ts";
import { fetchConfig } from "../lib/api.ts";
import type { ProviderConfig, TrustLevel } from "../types.ts";

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
  const [criteriaLine, setCriteriaLine] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);

  useEffect(() => {
    void fetchConfig().then((cfg) => {
      setProviders(cfg.providers);
      setProviderId(cfg.defaultProviderId || cfg.providers[0]?.id || null);
    }).catch(() => {});
  }, []);

  const submit = () => {
    if (!goal.trim() || loading) return;
    void createSession({
      goal: goal.trim(),
      ...(projectId ? { projectId } : {}),
      ...(providerId ? { providerId } : {}),
      trustLevel: trust,
      ...(trust === "high" ? { criteria: parseCriteria(criteriaLine) } : {}),
    });
    setGoal("");
    setCriteriaLine("");
  };

  return (
    <div style={{ maxWidth: 720, margin: "18vh auto 0", padding: "0 24px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
        What should Forge do?
      </div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 14 }}>
        The agent reads, writes and runs commands in your project. Completion is verified before it's called done.
      </div>
      <div className="composer-box">
        <textarea
          className="composer-ta"
          placeholder="Describe the engineering task…  (Enter to start · Shift+Enter for a new line)"
          value={goal}
          rows={3}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-actions" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, minWidth: 0 }}>
            <select
              className="composer-model-select"
              value={providerId ?? ""}
              onChange={(e) => setProviderId(e.target.value)}
              title="Model subscription for this session"
            >
              {providers.length === 0 && <option value="">no subscription</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.modelId}
                </option>
              ))}
            </select>
            <select
              className="composer-model-select"
              value={trust}
              onChange={(e) => setTrust(e.target.value as TrustLevel)}
              title="low: no verification · medium: project checks · high: criteria + evaluator"
            >
              <option value="low">trust: low</option>
              <option value="medium">trust: medium</option>
              <option value="high">trust: high</option>
            </select>
            {trust === "high" && (
              <input
                className="input"
                style={{ flex: 1, minWidth: 120, fontSize: 12 }}
                placeholder="criteria: file_exists:hello.txt · file_contains:hello.txt:export"
                value={criteriaLine}
                onChange={(e) => setCriteriaLine(e.target.value)}
              />
            )}
          </div>
          <button className="btn btn-primary" onClick={submit} disabled={!goal.trim() || loading}>
            {loading ? "Starting…" : "Create  (↵)"}
          </button>
        </div>
      </div>
      {error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
