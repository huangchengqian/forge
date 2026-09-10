import { useEffect, useState } from "react";
import { fetchConfig, saveConfig } from "../lib/api.ts";
import type { ForgeConfigData, ProviderApi } from "../types.ts";

const PROTOCOLS: ProviderApi[] = ["anthropic-messages", "openai-completions", "openai-responses"];

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
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal modal-lg">
        <div className="modal-head">
          <div>
            <h3 className="modal-title">Model subscriptions</h3>
            <div className="modal-sub">
              Every subscription Forge can run. The selected one is the default for new sessions;
              an active session can switch at its next turn boundary.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="modal-scroll">
          {!config && <div className="modal-sub">Loading…</div>}

          {config?.providers.length === 0 && (
            <div className="modal-sub">No subscriptions yet — add one to start running tasks.</div>
          )}

          {config?.providers.map((p) => (
            <div key={p.id} className="card">
              <div className="prov-head">
                <input
                  className="radio"
                  type="radio"
                  name="default-provider"
                  checked={config.defaultProviderId === p.id}
                  onChange={() => update({ defaultProviderId: p.id })}
                  title="Use as the default subscription"
                />
                <span className="prov-id">{p.id}</span>
                {config.defaultProviderId === p.id && <span className="prov-default">default</span>}
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

              <div className="field-grid">
                <span className="field-label">protocol</span>
                <select
                  className="input"
                  value={p.api}
                  onChange={(e) => updateProvider(p.id, { api: e.target.value as ProviderApi })}
                >
                  {PROTOCOLS.map((api) => (
                    <option key={api} value={api}>
                      {api}
                    </option>
                  ))}
                </select>

                <span className="field-label">model</span>
                <input
                  className="input"
                  value={p.modelId}
                  placeholder="e.g. MiniMax-M2.7"
                  onChange={(e) => updateProvider(p.id, { modelId: e.target.value })}
                />

                <span className="field-label">baseUrl</span>
                <input
                  className="input"
                  value={p.baseUrl}
                  onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                />

                <span className="field-label">apiKey</span>
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
              config &&
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
        </div>

        <div className="modal-foot">
          <span className="modal-error">{error}</span>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !config}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
