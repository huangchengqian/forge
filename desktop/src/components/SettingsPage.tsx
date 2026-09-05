import { useState } from "react";
import type { ProviderCheckResult, ProviderConfig } from "../lib/desktop-client.ts";

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
  providers: ProviderConfig[];
  defaultProviderId: string | null;
  maxConcurrency: number;
};

export type TestOutcome = {
  provider: ProviderCheckResult;
  runtime: ProviderCheckResult | null;
  status: string;
};

function presetLabel(baseUrl: string): string {
  return PRESETS.find((p) => p.baseUrl === baseUrl)?.label ?? "Custom";
}

function SubscriptionForm({ initial, onSave, onCancel, onTest }: {
  initial: ProviderConfig | null;
  onSave: (p: ProviderConfig) => void;
  onCancel: () => void;
  onTest: (provider: Record<string, string>) => Promise<TestOutcome>;
}) {
  const [api, setApi] = useState(initial?.api ?? "anthropic-messages");
  const [presetId, setPresetId] = useState<string | null>(initial ? (PRESETS.find((p) => p.baseUrl === initial.baseUrl)?.id ?? null) : null);
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const presetsForProtocol = PRESETS.filter((p) => p.api === api);

  function choosePreset(id: string | null) {
    setPresetId(id);
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) {
      setApi(preset.api);
      setBaseUrl(preset.baseUrl);
      setModelId(preset.defaultModel);
    }
  }

  function chooseProtocol(next: string) {
    setApi(next);
    setPresetId(null);
  }

  function build(): Record<string, string> {
    return { api, apiKey, modelId: modelId.trim(), baseUrl: baseUrl.trim() };
  }

  async function handleTest() {
    setTesting(true); setError(null); setTestResult(null);
    try {
      const r = await onTest(build());
      setTestResult(r);
      if (r.status === "FAIL") setError("Readiness check failed — see checks below.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Readiness check failed");
    }
    setTesting(false);
  }

  function submit() {
    if (!apiKey || !modelId.trim() || !baseUrl.trim()) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      api,
      apiKey,
      modelId: modelId.trim(),
      baseUrl: baseUrl.trim(),
    });
  }

  const valid = !!apiKey && !!modelId.trim() && !!baseUrl.trim();

  return (
    <div style={formBox}>
      <div style={sectionTitle}>Protocol</div>
      {PROTOCOLS.map((p) => (
        <label key={p.id} onClick={() => chooseProtocol(p.id)}
          style={{ ...radioRow, borderColor: api === p.id ? "var(--accent)" : "var(--border)" }}>
          <input type="radio" checked={api === p.id} onChange={() => chooseProtocol(p.id)} />
          <span style={{ fontWeight: 600 }}>{p.label}</span>
        </label>
      ))}

      <div style={{ ...sectionTitle, marginTop: 12 }}>Provider</div>
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
      </label>

      <div style={lbl}>Base URL</div>
      <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setPresetId(null); }} placeholder="https://api.example.com" style={inp} />
      <div style={lbl}>API Key</div>
      <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." style={inp} />
      <div style={lbl}>Model ID</div>
      <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="model-id" style={inp} />

      {testResult?.provider && (
        <div style={checkBlock}>
          {testResult.provider.checks.map((c, i) => (
            <div key={i} style={checkRow}>
              <span style={{ color: c.status === "PASS" ? "var(--green)" : c.status === "SKIP" ? "var(--text-muted)" : "var(--red)" }}>{c.status === "PASS" ? "\u2713" : c.status === "SKIP" ? "\u2014" : "\u2717"} {c.status}</span>
              <span style={{ marginLeft: 8 }}>{c.name}</span>
            </div>
          ))}
          {testResult.runtime && (
            <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>Runtime (via Pi)</div>
          )}
        </div>
      )}
      {error && <div style={errBox}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={submit} disabled={!valid} style={primaryBtn}>{initial ? "Save subscription" : "Add subscription"}</button>
        <button onClick={handleTest} disabled={!valid || testing} style={ghostBtn}>{testing ? "Testing…" : "Test connection"}</button>
        <button onClick={onCancel} style={ghostBtn}>Cancel</button>
      </div>
    </div>
  );
}

export function SettingsPage({ config, onSave, onTest }: {
  config: ForgeConfigData;
  onSave: (config: Partial<ForgeConfigData>) => Promise<void>;
  onTest: (provider: Record<string, string>) => Promise<TestOutcome>;
}) {
  const [providers, setProviders] = useState<ProviderConfig[]>(config.providers);
  const [defaultId, setDefaultId] = useState<string | null>(config.defaultProviderId ?? config.providers[0]?.id ?? null);
  const [maxConcurrency, setMaxConcurrency] = useState(config.maxConcurrency);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const editingProvider = editing && editing !== "new"
    ? providers.find((p) => p.id === editing) ?? null
    : null;

  function upsert(p: ProviderConfig) {
    setProviders((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i >= 0) { const next = [...prev]; next[i] = p; return next; }
      return [...prev, p];
    });
    if (!defaultId) setDefaultId(p.id);
    setEditing(null);
  }

  function remove(id: string) {
    setProviders((prev) => prev.filter((p) => p.id !== id));
    if (defaultId === id) setDefaultId(null);
    setEditing(null);
  }

  async function handleSave() {
    setSaving(true); setSaved(false); setSaveError(null);
    try {
      await onSave({
        providers,
        defaultProviderId: defaultId ?? providers[0]?.id ?? null,
        maxConcurrency,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  }

  if (editing !== null) {
    return (
      <div style={pageStyle}>
        <h2 style={h2}>{editing === "new" ? "Add subscription" : "Edit subscription"}</h2>
        <SubscriptionForm
          initial={editingProvider}
          onSave={upsert}
          onCancel={() => setEditing(null)}
          onTest={onTest}
        />
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <h2 style={h2}>Settings</h2>

      <div style={section}>
        <div style={sectionTitle}>Model subscriptions</div>
        {providers.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 0" }}>
            No subscriptions yet. Add one to start using Forge with your own models.
          </div>
        )}
        {providers.map((p) => (
          <div key={p.id} style={subCard}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{presetLabel(p.baseUrl)}</span>
                {defaultId === p.id && <span style={badge}>default</span>}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>{p.modelId}</div>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.baseUrl}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
              {defaultId !== p.id && (
                <button onClick={() => setDefaultId(p.id)} style={linkBtn}>Set default</button>
              )}
              <button onClick={() => setEditing(p.id)} style={linkBtn}>Edit</button>
              <button onClick={() => remove(p.id)} style={{ ...linkBtn, color: "var(--red)" }}>Remove</button>
            </div>
          </div>
        ))}
        <button onClick={() => setEditing("new")} style={{ ...ghostBtn, marginTop: 8 }}>＋ Add subscription</button>
      </div>

      <div style={section}>
        <div style={sectionTitle}>Runtime</div>
        <div style={lbl}>Max concurrent steps</div>
        <input type="number" value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} min={1} max={10} style={{ ...inp, width: 80 }} />
      </div>

      {saveError && <div style={errBox}>{saveError}</div>}

      <button onClick={handleSave} disabled={saving || providers.length === 0} style={saveBtn}>{saving ? "Saving…" : saved ? "✓ Saved" : "Save Settings"}</button>
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
const formBox = { backgroundColor: "var(--bg-secondary)", padding: 16, borderRadius: 6 };
const subCard = { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg)", marginBottom: 8 };
const badge = { fontSize: 10, padding: "1px 6px", borderRadius: 4, backgroundColor: "var(--accent)", color: "#fff" };
const linkBtn = { background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0 };
const primaryBtn = { padding: "8px 16px", borderRadius: 4, border: "none", backgroundColor: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 13 };
const ghostBtn = { padding: "8px 16px", borderRadius: 4, border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 13 };
const saveBtn = { padding: "10px 20px", borderRadius: 4, border: "none", backgroundColor: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 14, marginTop: 8 };
const checkBlock = { backgroundColor: "var(--bg)", padding: 8, borderRadius: 4, marginTop: 8 };
const checkRow = { display: "flex", gap: 6, fontSize: 11, padding: "2px 0", color: "var(--text-secondary)" };
const errBox = { backgroundColor: "var(--error-bg)", color: "var(--red)", border: "1px solid var(--red)", borderRadius: 6, padding: 10, fontSize: 12, marginTop: 8 };
