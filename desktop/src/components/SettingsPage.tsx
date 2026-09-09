import { useEffect, useState } from "react";
import { fetchConfig, saveConfig } from "../lib/api.ts";
import type { ForgeConfigData, ProviderApi } from "../types.ts";

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ForgeConfigData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  const update = (patch: Partial<ForgeConfigData>) => {
    if (!config) return;
    setConfig({ ...config, ...patch });
  };

  const updateProvider = (id: string, patch: Partial<ForgeConfigData["providers"][number]>) => {
    if (!config) return;
    setConfig({
      ...config,
      providers: config.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveConfig(config);
      setConfig(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1500,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          width: 640,
          maxWidth: "92vw",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Model subscriptions
          </div>
          <button className="btn btn-ghost btn-small" onClick={onClose}>Close</button>
        </div>

        {!config && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>}
        {config && (
          <>
            {config.providers.map((p) => (
              <div key={p.id} className="card">
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <input
                    type="radio"
                    name="default-provider"
                    checked={config.defaultProviderId === p.id}
                    onChange={() => update({ defaultProviderId: p.id })}
                    title="Default subscription"
                  />
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {p.id}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button
                    className="btn btn-danger btn-small"
                    onClick={() =>
                      update({
                        providers: config.providers.filter((x) => x.id !== p.id),
                        defaultProviderId:
                          config.defaultProviderId === p.id
                            ? (config.providers.find((x) => x.id !== p.id)?.id ?? "")
                            : config.defaultProviderId,
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 6, fontSize: 12.5 }}>
                  <span style={{ color: "var(--text-muted)", alignSelf: "center" }}>protocol</span>
                  <select
                    className="input"
                    value={p.api}
                    onChange={(e) => updateProvider(p.id, { api: e.target.value as ProviderApi })}
                  >
                    <option value="anthropic-messages">anthropic-messages</option>
                    <option value="openai-completions">openai-completions</option>
                    <option value="openai-responses">openai-responses</option>
                  </select>
                  <span style={{ color: "var(--text-muted)", alignSelf: "center" }}>model</span>
                  <input
                    className="input"
                    value={p.modelId}
                    onChange={(e) => updateProvider(p.id, { modelId: e.target.value })}
                  />
                  <span style={{ color: "var(--text-muted)", alignSelf: "center" }}>baseUrl</span>
                  <input
                    className="input"
                    value={p.baseUrl}
                    onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                  />
                  <span style={{ color: "var(--text-muted)", alignSelf: "center" }}>apiKey</span>
                  <input
                    className="input"
                    type="password"
                    value={p.apiKey}
                    onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                  />
                </div>
              </div>
            ))}
            <button
              className="btn btn-ghost btn-small"
              onClick={() =>
                update({
                  providers: [
                    ...config.providers,
                    {
                      id: `prov_${Math.random().toString(36).slice(2, 7)}`,
                      api: "openai-completions",
                      modelId: "",
                      baseUrl: "https://api.openai.com/v1",
                      apiKey: "",
                    },
                  ],
                })
              }
            >
              + Add subscription
            </button>
            {error && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
