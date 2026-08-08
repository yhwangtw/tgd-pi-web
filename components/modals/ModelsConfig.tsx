"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ModelEntry, ProviderEntry, ModelsJson, ModelTestState, Selection, OAuthProvider, ApiKeyProvider } from "./models-config-types";
import { API_OPTIONS } from "./models-config-types";
import { Field, TextInput, SecretTextInput, NumInput, Select, Check, SectionTitle } from "./models-config-forms";
import { ProviderIcon } from "./ProviderIcon";
import { OAuthDetail } from "./OAuthDetail";
import { ApiKeyDetail } from "./ApiKeyDetail";
import { AddProviderPicker } from "./AddProviderPicker";
import { ProviderHealth } from "./ProviderHealth";
import { useI18n } from "@/lib/i18n";
import styles from "./ModelsConfig.module.css";

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({ name, provider, onChange, onRename, onDelete }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void; onDelete: () => void;
}) {
  const [editingName, setEditingName] = useState(name);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  return (
    <div className={styles.detailSection}>
      <div className={styles.detailHeader}>
        <SectionTitle>Provider</SectionTitle>
        <button onClick={onDelete} className={styles.deleteButton}>
          Delete
        </button>
      </div>

      <Field label="Provider name">
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button onClick={() => onRename(editingName.trim())} className={styles.renameButton}>
            Rename
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label="API Key">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key" mono />
        <span className={styles.helperText}>
          Prefix with <code className={styles.helperCode}>!</code> to run a shell command, or use an env var name
        </span>
      </Field>

      <Field label="API">
        <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
      </Field>
    </div>
  );
}


// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "var(--color-thinking)",
  low:     "var(--color-thinking-low)",
  medium:  "var(--color-thinking-med)",
  high:    "var(--color-thinking-high)",
  xhigh:   "var(--color-thinking-max)",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div className={styles.thinkingLevelMap}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        return (
          <div key={level} className={styles.levelRow}>
            {/* Level badge */}
            <div className={styles.levelBadge}>
              <span
                className={styles.levelDot}
                style={{ background: color, opacity: state === "null" ? 0.3 : 1 }}
              />
              <span
                className={`${styles.levelLabel} ${state === "null" ? styles.levelLabelDisabled : styles.levelLabelOmit}`}
              >
                {level}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div className={styles.thinkingBtnGroup}>
              <button
                onClick={() => setLevel(level, "omit")}
                className={`${styles.thinkingBtn} ${state === "omit" ? styles.thinkingBtnActive : ""}`}
              >
                Default
              </button>
              <button
                onClick={() => setLevel(level, null)}
                className={`${styles.thinkingBtn} ${styles.thinkingBtnBorderLeft} ${state === "null" ? styles.thinkingBtnDisabled : ""}`}
              >
                Disabled
              </button>
            </div>

            {/* Custom button + input fused */}
            <div className={`${styles.customInputGroup} ${state === "string" ? styles.customInputGroupActive : styles.customInputGroupInactive}`}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                className={`${styles.thinkingBtn} ${styles.thinkingBtnBorderRight} ${state === "string" ? styles.thinkingBtnActive : ""}`}
              >
                Custom
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                className={`${styles.customInput} ${state === "string" ? styles.customInputActive : styles.customInputInactive}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return "Testing model connection...";
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return ["Connected", ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return ["Failed", ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  const isTestDisabled = !model.id.trim() || testState.phase === "testing";

  return (
    <div className={styles.detailSection}>
      <div className={styles.detailHeader}>
        <SectionTitle>Model</SectionTitle>
        <div className={styles.testButtonGroup}>
          {testSummary && (
            <span
              title={testSummary}
              className={`${styles.testSummary} ${
                testState.phase === "error" ? styles.testSummaryError :
                testState.phase === "success" ? styles.testSummarySuccess :
                styles.testSummaryIdle
              }`}
            >
              {testSummary}
            </span>
          )}
          <button
            onClick={handleTest}
            disabled={isTestDisabled}
            title="Test model connection"
            className={`${styles.testButton} ${isTestDisabled ? styles.testButtonDisabled : ""} ${testState.phase === "success" ? styles.testButtonSuccess : ""}`}
          >
            {testState.phase === "success" && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing" ? "Testing…" : testState.phase === "success" ? "OK" : "Test"}
          </button>
          <button onClick={onDelete} className={styles.removeButton}>
            Remove
          </button>
        </div>
      </div>

      <div className={styles.twoColGrid}>
        <Field label="ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label="Name"><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder="Display name" /></Field>
      </div>

      <Field label="API override">
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div className={styles.checkRow}>
        <Check label="Reasoning / thinking" checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
        <Check label="Image input" checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
      </div>

      {model.reasoning && (
        <>
          <Check
            label="DeepSeek thinking compat"
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div className={styles.thinkingLevelHeader}>
              <SectionTitle>Thinking level map</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  onClick={() => set("thinkingLevelMap", undefined)}
                  className={styles.clearAllButton}
                >
                  clear all
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor
              value={model.thinkingLevelMap}
              onChange={(v) => set("thinkingLevelMap", v)}
            />
          </div>
        </>
      )}

      <div className={styles.twoColGrid}>
        <Field label="Context window (tokens)">
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label="Max output tokens">
          <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
        </Field>
      </div>

      <div>
        <SectionTitle>Cost (per million tokens)</SectionTitle>
        <div className={styles.costGrid}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={k}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}


// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>({ type: "health" });
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const savedConfigRef = useRef(JSON.stringify({ providers: {} }));

  // Esc closes the modal — consistent with AnalyticsModal and the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadOAuthProviders = useCallback(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { providers: OAuthProvider[] }) => setOauthProviders(d.providers))
      .catch(() => {});
  }, []);

  const loadApiKeyProviders = useCallback(() => {
    fetch("/api/auth/all-providers")
      .then((r) => r.json())
      .then((d: { providers: ApiKeyProvider[] }) => setApiKeyProviders(d.providers))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/models-config")
      .then((r) => r.json())
      .then((d: ModelsJson) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        savedConfigRef.current = JSON.stringify(normalized);
        setSelection({ type: "health" });
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadOAuthProviders, loadApiKeyProviders]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const idx = entries.findIndex(([k]) => k === oldName);
      if (idx === -1) return prev;
      entries[idx] = [newName, entries[idx][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    setSelection({ type: "provider", name: providerName });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else {
        savedConfigRef.current = JSON.stringify(config);
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config]);

  const providers = Object.entries(config.providers ?? {});
  const hasUnsavedChanges = JSON.stringify(config) !== savedConfigRef.current;
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "health") return <ProviderHealth />;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={loadOAuthProviders} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={loadApiKeyProviders} />;
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
    <div className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={styles.modal}
        data-testid="models-config-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="models-config-title"
      >

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span id="models-config-title" className={styles.title}>Models</span>
            <code className={styles.configPath}>~/.pi/agent/models.json</code>
          </div>
          <button onClick={onClose} className={styles.closeButton} aria-label="Close Models">×</button>
        </div>

        {/* Body */}
        <div className={styles.body}>

          {/* Left: tree */}
          <div className={styles.sidebar} data-testid="models-config-nav">
            <div className={styles.sidebarScroll}>
              <button
                type="button"
                onClick={() => setSelection({ type: "health" })}
                className={`${styles.healthRow} ${selection?.type === "health" ? styles.treeItemSelected : "hover-bg"}`}
                data-testid="provider-health-nav"
              >
                <span className={styles.healthIcon} aria-hidden>✓</span>
                <span className={styles.treeItemText}>{t("providerHealth.title")}</span>
              </button>
              <div className={styles.divider} />
              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                    className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ""} ${!isSelected ? "hover-bg" : ""}`}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <span className={styles.treeItemText}>{p.name}</span>
                  </div>
                );
              })}

              {/* Active API key providers */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                    className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ""} ${!isSelected ? "hover-bg" : ""}`}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <span className={styles.treeItemText}>{p.displayName}</span>
                  </div>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                <div className={styles.divider} />
              )}

              {/* Custom providers */}
              {loading ? (
                <div className={styles.loadingText}>Loading…</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} className={styles.providerGroup}>
                    {/* Provider row */}
                    <div
                      onClick={() => setSelection({ type: "provider", name: pName })}
                      className={`${styles.providerRow} ${isProviderSelected ? styles.providerRowSelected : ""} ${!isProviderSelected ? "hover-bg" : ""}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.providerIcon}>
                        <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                      <span className={`${styles.providerName} ${isProviderSelected ? styles.providerNameSelected : ""}`}>
                        {pName}
                      </span>
                    </div>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      return (
                        <div
                          key={i}
                          onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                          className={`${styles.modelRow} ${isModelSelected ? styles.modelRowSelected : ""} ${!isModelSelected ? "hover-bg" : ""}`}
                        >
                          <span className={`${styles.modelName} ${!m.id ? styles.modelNameEmpty : ""}`}>
                            {m.id || "new model"}
                          </span>
                          {m.reasoning && (
                            <span className={styles.reasoningBadge}>T</span>
                          )}
                        </div>
                      );
                    })}

                    {/* Add model button */}
                    <div
                      onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                      className={`${styles.addModelButton} hover-bg-text`}
                    >
                      <span className={styles.addModelText}>+ model</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add provider */}
            <div className={styles.addProviderWrapper}>
              <button onClick={() => setPickerOpen(true)}
                className={`${styles.addProviderButton} hover-border-accent`}
              >
                + Add provider
              </button>
            </div>
          </div>

          {/* Right: detail */}
          <div className={styles.rightPanel} data-testid="models-config-detail">
            {loading ? null : detailContent ?? (
              <div className={styles.emptyState}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3" />
                </svg>
                <strong>No model selected</strong>
                <span>Select a provider from the left, or connect a new one.</span>
                <button type="button" onClick={() => setPickerOpen(true)}>Add provider</button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          {saveError && <span className={styles.saveErrorText}>{saveError}</span>}
          <button onClick={onClose} className={styles.cancelButton}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || savedOk || !hasUnsavedChanges}
            className={`${styles.saveButton} ${savedOk ? styles.saveButtonSaved : saving ? styles.saveButtonSaving : styles.saveButtonReady}`}>
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                className={styles.saveCheckIcon}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{savedOk ? "Saved" : saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
    </div>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id: string) => setSelection({ type: "oauth", providerId: id })}
        onSelectApiKey={(id: string) => setSelection({ type: "apikey", providerId: id })}
        onAddCustom={addCustomProvider}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
