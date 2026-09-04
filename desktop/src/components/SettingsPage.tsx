import { useState } from "react";
import type { ProviderCheckResult } from "../lib/desktop-client.ts";

// Protocol is the primary axis; vendors are presets that pin a baseUrl to one
// protocol. Keep this table in sync with src/server/config-store.ts
// PROVIDER_PRESETS (same ids, baseUrls, default models).
const PROTOCOLS = [
  { id: "anthropic-messages", label: "Anthropic (messages)" },
  { id: "openai-completions", label: "OpenAI (chat/completions)" },
  { id: "openai-responses", label: "OpenAI (responses)" },
] as const;

const PRESETS = [
  { id: "anthropic", label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
  { id: "minimax", label: "MiniMax", api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic", defaultModel: "MiniMax-M3" },
  { id: "minimax-cn", label: "MiniMax (国内)", api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic", defaultModel: "MiniMax-M3" },
  { id: "kimi-coding", label: "Kimi (coding)", api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding", defaultModel: "kimi-for-coding" },
  { id: "openai", label: "OpenAI", api: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5" },
  { id: "deepseek", label: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro" },
  { id: "moonshotai", label: "Moonshot (Kimi)", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-k2.5" },
  { id: "groq", label: "Groq", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
] as const;

export type ForgeConfigData = {
  provider: { api: string; apiKey: string; modelId: string; baseUrl: string } | null;
  maxConcurrency: number;
};

function presetFor(config: ForgeConfigData["provider"]): string | null {
  if (!config) return null;
  const hit = PRESETS.find((p) => p.baseUrl === config.baseUrl);
  return hit?.id ?? null;
}

export function SettingsPage({ config, onSave, onTest, testResult }: {
  config: ForgeConfigData;
  onSave: (config: Partial<ForgeConfigData>) => Promise<void>;
  onTest: (provider: Record<string, string>) => Promise<{ provider: ProviderCheckResult; runtime: ProviderCheckResult | null; status: string }>;
  testResult: { provider: ProviderCheckResult; runtime: ProviderCheckResult | null; status: string } | null;
}) {
  const [api, setApi] = useState(config.provider?.api ?? "anthropic-messages");
  const [presetId, setPresetId] = useState<string | null>(presetFor(config.provider));
  const [apiKey, setApiKey] = useState(config.provider?.apiKey ?? "");
  const [modelId, setModelId] = useState(config.provider?.modelId ?? "");
  const [baseUrl, setBaseUrl] = useState(config.provider?.baseUrl ?? "");
  const [maxConcurrency, setMaxConcurrency] = useState(config.maxConcurrency);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const presetsForProtocol = PRESETS.filter((p) => p.api === api);

  function choosePreset(id: string | null) {
    setPresetId(id);
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) {
      setApi(preset.api);
      setBaseUrl(preset.baseUrl);
      if (!modelId || modelId === "custom") setModelId(preset.defaultModel);
    }
  }

  function chooseProtocol(next: string) {
    setApi(next);
    // Changing protocol invalidates the vendor pin; keep whatever baseUrl the
    // user already had (they may be re-pointing the same endpoint).
    setPresetId(null);
  }

  function buildProvider(): { api: string; apiKey: string; modelId: string; baseUrl: string } {
    return { api, apiKey, modelId: modelId.trim(), baseUrl: baseUrl.trim() };
  }

  async function handleSave() {
    setSaving(true); setSaved(false); setSaveError(null);
    try {
      await onSave({ provider: buildProvider(), maxConcurrency });
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
      const r = await onTest(buildProvider());
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
        <div style={sectionTitle}>1 · Protocol</div>
        {PROTOCOLS.map((p) => (
          <label key={p.id} onClick={() => chooseProtocol(p.id)}
            style={{ ...radioRow, borderColor: api === p.id ? "var(--accent)" : "var(--border)" }}>
            <input type="radio" checked={api === p.id} onChange={() => chooseProtocol(p.id)} />
            <span style={{ fontWeight: 600 }}>{p.label}</span>
          </label>
        ))}
      </div>

      <div style={section}>
        <div style={sectionTitle}>2 · Provider</div>
        {presetsForProtocol.map((p) => (
          <label key={p.id} onClick={() => choosePreset(p.id)}
            style={{ ...radioRow, borderColor: presetId === p.id ? "var(--accent)" : "var(--border)" }}>
            <input type="radio" checked={presetId === p.id} onChange={() => choosePreset(p.id)} />
            <span style={{ fontWeight: 600 }}>{p.label}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.baseUrl}</span>
          </label>
        ))}
        <label onClick={() => choosePreset(null)}
          style={{ ...radioRow, borderColor: presetId === null ? "var(--accent)" : "var(--border)" }}>
          <input type="radio" checked={presetId === null} onChange={() => choosePreset(null)} />
          <span style={{ fontWeight: 600 }}>Custom endpoint</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>any {api} base URL</span>
        </label>

        <div style={lbl}>Base URL</div>
        <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setPresetId(null); }} placeholder="https://api.example.com" style={inp} />
        <div style={lbl}>API Key</div>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." style={inp} />
        <div style={lbl}>Model ID</div>
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="model-id" style={inp} />

        <button onClick={handleTest} disabled={!apiKey || !modelId.trim() || !baseUrl.trim() || testing} style={{ ...testBtn, marginTop: 8 }}>
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

      <button onClick={handleSave} disabled={saving || !apiKey || !modelId.trim() || !baseUrl.trim()} style={saveBtn}>{saving ? "Saving…" : saved ? "✓ Saved" : "Save Settings"}</button>
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
