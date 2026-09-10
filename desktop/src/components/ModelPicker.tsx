import { useEffect, useRef, useState } from "react";
import type { ProviderConfig, TrustLevel } from "../types.ts";
import { TRUST_LEVELS, trustLabel } from "../lib/verification.ts";

/** Small inline check — drawn rather than typed so it sits on the text
 * baseline instead of reading as a glyph. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M4 6.5l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Endpoint host — tells two subscriptions apart without leaking the
 * protocol, which is an implementation detail the user never picked. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/**
 * Model subscription + completion-verification picker, in one popover.
 *
 * These belong together: both answer "how should this session run", both are
 * switched from the same place, and both apply from the next turn boundary.
 * The raw word `trust` never reaches the user — see lib/verification.ts for
 * what the levels actually do.
 */
export function ModelPicker({
  providers,
  activeProviderId,
  activeModelLabel,
  onSelectModel,
  trustLevel,
  onSelectTrust,
  placement = "above",
  disabled = false,
  defaultOpen = false,
}: {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  /** Model the session is actually running on. Used when its subscription is
   * gone from the config (deleted or renamed) so the trigger still reports the
   * truth instead of falling back to "未选择模型". */
  activeModelLabel?: string | undefined;
  onSelectModel: (providerId: string) => void;
  trustLevel: TrustLevel;
  onSelectTrust: (level: TrustLevel) => void;
  /** Which way the panel opens. Composers sit at the bottom → "above". */
  placement?: "above" | "below";
  disabled?: boolean;
  /** Render with the panel already open — the dev preview harness uses this. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active = providers.find((p) => p.id === activeProviderId) ?? null;
  const modelLabel = active?.modelId ?? activeModelLabel ?? "未选择模型";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="运行方式：模型订阅与完成验证"
      >
        <span className="picker-model">{modelLabel}</span>
        <span className="picker-dot" aria-hidden="true" />
        <span className="picker-trust">{trustLabel(trustLevel)}</span>
        <span className={`picker-caret${open ? " is-open" : ""}`}>
          <CaretIcon />
        </span>
      </button>

      {open && (
        <div className={`picker-panel picker-panel-${placement}`} role="listbox">
          <div className="picker-group">
            <div className="picker-group-label">模型订阅</div>
            {providers.length === 0 && <div className="picker-empty">尚未配置模型订阅</div>}
            {providers.map((p) => {
              const on = p.id === activeProviderId;
              const host = hostOf(p.baseUrl);
              return (
                <button
                  key={p.id}
                  type="button"
                  className="picker-option"
                  data-active={on || undefined}
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    if (!on) onSelectModel(p.id);
                    setOpen(false);
                  }}
                >
                  <span className="picker-mark">{on && <CheckIcon />}</span>
                  <span className="picker-option-body">
                    <span className="picker-option-label">{p.modelId}</span>
                    {host && <span className="picker-option-hint">{host}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="picker-rule" />

          <div className="picker-group">
            <div className="picker-group-label">完成验证</div>
            {TRUST_LEVELS.map((level) => {
              const on = level.value === trustLevel;
              return (
                <button
                  key={level.value}
                  type="button"
                  className="picker-option"
                  data-active={on || undefined}
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    if (!on) onSelectTrust(level.value);
                    setOpen(false);
                  }}
                >
                  <span className="picker-mark">{on && <CheckIcon />}</span>
                  <span className="picker-option-body">
                    <span className="picker-option-label">{level.label}</span>
                    <span className="picker-option-hint">{level.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
