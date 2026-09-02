import { useState } from "react";
import type { ProviderCheckResult } from "../lib/desktop-client.ts";

const PROVIDERS = [
  { kind: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", defaultModel: "MiniMax-M3" },
  { kind: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
  { kind: "openai-compatible", label: "OpenAI Compatible", baseUrl: "", defaultModel: "" },
] as const;

const PROTOCOLS = [
  { id: "openai-completions", label: "OpenAI (chat/completions)" },
  { id: "openai-responses", label: "OpenAI (responses)" },
  { id: "anthropic-messages", label: "Anthropic (messages)" },
] as const;

export type ForgeConfigData = {
  provider: { kind: string; apiKey: string; modelId: string; baseUrl: string; api?: string } | null;
  maxConcurrency: number;
};

export function SettingsPage({ config, onSave, onTest, testResult }: {
  config: ForgeConfigData;
  onSave: (config: Partial<ForgeConfigData>) => Promise<void>;
  onTest: (provider: Record<string, string>) => Promise<{ provider: ProviderCheckResult; runtime: ProviderCheckResult | null; status: string }>;
  testResult: { provider: ProviderCheckResult; runtime: ProviderCheckResult | null; status: string } | null;
}) {
  const [kind, setKind] = useState(config.provider?.kind ?? "anthropic");
  const [apiKey, setApiKey] = useState(config.provider?.apiKey ?? "");
  const [modelId, setModelId] = useState(config.provider?.modelId ?? "");
  const [baseUrl, setBaseUrl] = useState(config.provider?.baseUrl ?? "");
  const [api, setApi] = useState(config.provider?.api ?? "openai-completions");
  const [maxConcurrency, setMaxConcurrency] = useState(config.maxConcurrency);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selected = PROVIDERS.find((p) => p.kind === kind) ?? PROVIDERS[0]!;

  async function handleSave() {
    setSaving(true); setSaved(false); setSaveError(null);
    try {
      const provider: { kind: string; apiKey: string; modelId: string; baseUrl: string; api?: string } = {
        kind, apiKey,
        modelId: modelId || selected.defaultModel,
        baseUrl: kind === "openai-compatible" ? baseUrl : selected.baseUrl,
      };
      if (kind === "openai-compatible") provider.api = api;
      await onSave({ provider, maxConcurrency });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true); setSaveError(null);
    try {
      const body: Record<string, string> = {
        kind, apiKey, modelId: modelId || selected.defaultModel,
        baseUrl: kind === "openai-compatible" ? baseUrl : selected.baseUrl,
      };
      if (kind === "openai-compatible") body.api = api;
      const r = await onTest(body);
      if (r.status === "FAIL") setSaveError("Readiness check failed — see checks below.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Readiness check failed");
    }
    setTesting(false);
  }

  return (
    <div style={pageStyle}>
      <h2 style={h2}>Settings</h2>

      <div style={section}>
        <div style={sectionTitle}>Provider</div>
        {PROVIDERS.map((p) => (
          <label key={p.kind} onClick={() => { setKind(p.kind); if (!modelId) setModelId(p.defaultModel); }}
            style={{ ...radioRow, borderColor: kind === p.kind ? "var(--accent)" : "var(--border)" }}>
            <input type="radio" checked={kind === p.kind} onChange={() => { setKind(p.kind); }} />
            <span style={{ fontWeight: 600 }}>{p.label}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.baseUrl || "custom URL"}</span>
          </label>
        ))}
        <div style={lbl}>API Key</div>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." style={inp} />
        <div style={lbl}>Model ID</div>
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="model-id" style={inp} />
        {kind === "openai-compatible" && (
          <>
            <div style={lbl}>Base URL</div>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" style={inp} />
            <div style={lbl}>API protocol</div>
            {PROTOCOLS.map((pr) => (
              <label key={pr.id} onClick={() => setApi(pr.id)}
                style={{ ...radioRow, borderColor: api === pr.id ? "var(--accent)" : "var(--border)" }}>
                <input type="radio" checked={api === pr.id} onChange={() => setApi(pr.id)} />
                <span style={{ fontSize: 12 }}>{pr.label}</span>
              </label>
            ))}
          </>
        )}
        <button onClick={handleTest} disabled={!apiKey || testing} style={{ ...testBtn, marginTop: 8 }}>
          {testing ? "Running readiness check…" : "Run Readiness Check"}
        </button>
        {testResult?.provider && (
          <div style={checkBlock}>
            {testResult.provider.checks.map((c, i) => (
              <div key={i} style={checkRow}>
                <span style={{ color: c.status === "PASS" ? "var(--green)" : c.status === "SKIP" ? "var(--text-muted)" : "var(--red)" }}>{c.status === "PASS" ? "\u2713" : c.status === "SKIP" ? "\u2014" : "\u2717"} {c.status}</span>
                <span style={{ marginLeft: 8 }}>{c.name}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: "auto" }}>{c.message.slice(0, 50)}</span>
              </div>
            ))}
            {testResult.runtime && (
              <>
                <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>Runtime (via Pi)</div>
                {testResult.runtime.checks.map((c, i) => (
                  <div key={`r${i}`} style={checkRow}>
                    <span style={{ color: c.status === "PASS" ? "var(--green)" : c.status === "SKIP" ? "var(--text-muted)" : "var(--red)" }}>{c.status === "PASS" ? "\u2713" : c.status === "SKIP" ? "\u2014" : "\u2717"} {c.status}</span>
                    <span style={{ marginLeft: 8 }}>{c.name}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: "auto" }}>{c.message.slice(0, 50)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div style={section}>
        <div style={sectionTitle}>Runtime</div>
        <div style={lbl}>Max concurrent steps</div>
        <input type="number" value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} min={1} max={10} style={{ ...inp, width: 80 }} />
      </div>

      {saveError && <div style={errBox}>{saveError}</div>}

      <button onClick={handleSave} disabled={saving} style={saveBtn}>{saving ? "Saving…" : saved ? "✓ Saved" : "Save Settings"}</button>
    </div>
  );
}

const pageStyle = { padding: 16, maxWidth: 640 };
const h2 = { fontSize: 18, margin: "0 0 16px" };
const section = { backgroundColor: "var(--bg-secondary)", padding: 16, borderRadius: 6, marginBottom: 12 };
const sectionTitle = { fontSize: 13, fontWeight: 700, marginBottom: 8, color: "var(--text)" };
const lbl = { fontSize: 11, color: "var(--text-muted)", margin: "10px 0 2px" };
const inp = { width: "100%", padding: "8px 12px", borderRadius: 4, border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: 13, boxSizing: "border-box" as const };
const radioRow = { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 4, border: "1px solid", cursor: "pointer", marginBottom: 4 };
const testBtn = { padding: "8px 16px", borderRadius: 4, border: "none", backgroundColor: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 13 };
const saveBtn = { padding: "10px 20px", borderRadius: 4, border: "none", backgroundColor: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 14, marginTop: 8 };
const checkBlock = { backgroundColor: "var(--bg)", padding: 8, borderRadius: 4, marginTop: 8 };
const checkRow = { display: "flex", gap: 6, fontSize: 11, padding: "2px 0", color: "var(--text-secondary)" };
const errBox = { backgroundColor: "var(--error-bg)", color: "var(--red)", border: "1px solid var(--red)", borderRadius: 6, padding: 10, fontSize: 12, marginBottom: 12 };
