"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, CheckCircle2, Cpu, Plus } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
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
  const { t } = useI18n();
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
        <SectionTitle>{t("models.provider")}</SectionTitle>
        <button type="button" onClick={onDelete} className={styles.deleteButton}>
          {t("common.delete")}
        </button>
      </div>

      <Field label={t("models.providerName")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder={t("models.providerNamePlaceholder")} mono />
        {editingName !== name && editingName.trim() && (
          <button type="button" onClick={() => onRename(editingName.trim())} className={styles.renameButton}>
            {t("models.rename")}
          </button>
        )}
      </Field>

      <Field label={t("models.baseUrl")}>
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label={t("apiKey.title")}>
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("models.apiKeyPlaceholder")} ariaLabel={t("apiKey.title")} mono />
        <span className={styles.helperText}>
          {t("models.apiKeyHintBefore")} <code className={styles.helperCode}>!</code> {t("models.apiKeyHintAfter")}
        </span>
      </Field>

      <Field label={t("models.api")}>
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
  const { t } = useI18n();
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
                aria-hidden="true"
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
                type="button"
                onClick={() => setLevel(level, "omit")}
                className={`${styles.thinkingBtn} ${state === "omit" ? styles.thinkingBtnActive : ""}`}
              >
                {t("models.default")}
              </button>
              <button
                type="button"
                onClick={() => setLevel(level, null)}
                className={`${styles.thinkingBtn} ${styles.thinkingBtnBorderLeft} ${state === "null" ? styles.thinkingBtnDisabled : ""}`}
              >
                {t("models.disabled")}
              </button>
            </div>

            {/* Custom button + input fused */}
            <div className={`${styles.customInputGroup} ${state === "string" ? styles.customInputGroupActive : styles.customInputGroupInactive}`}>
              <button
                type="button"
                onClick={() => setLevel(level, strVal || level)}
                className={`${styles.thinkingBtn} ${styles.thinkingBtnBorderRight} ${state === "string" ? styles.thinkingBtnActive : ""}`}
              >
                {t("models.custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                aria-label={t("models.customThinkingLevel").replace("{level}", level)}
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
  const { t } = useI18n();
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("models.testingConnection");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("models.connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return [t("models.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
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
        <SectionTitle>{t("models.model")}</SectionTitle>
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
            type="button"
            onClick={handleTest}
            disabled={isTestDisabled}
            title={t("models.testConnection")}
            className={`${styles.testButton} ${isTestDisabled ? styles.testButtonDisabled : ""} ${testState.phase === "success" ? styles.testButtonSuccess : ""}`}
          >
            {testState.phase === "success" && (
              <CheckCircle2 size={14} strokeWidth={2.4} aria-hidden="true" />
            )}
            {testState.phase === "testing" ? t("models.testing") : testState.phase === "success" ? "OK" : t("models.test")}
          </button>
          <button type="button" onClick={onDelete} className={styles.removeButton}>
            {t("common.remove")}
          </button>
        </div>
      </div>

      <div className={styles.twoColGrid}>
        <Field label={t("models.idRequired")}><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder={t("models.modelIdPlaceholder")} mono /></Field>
        <Field label={t("models.name")}><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={t("models.displayNamePlaceholder")} /></Field>
      </div>

      <Field label={t("models.apiOverride")}>
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div className={styles.checkRow}>
        <Check label={t("models.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
        <Check label={t("models.imageInput")} checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
      </div>

      {model.reasoning && (
        <>
          <Check
            label={t("models.deepseekCompat")}
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div className={styles.thinkingLevelHeader}>
              <SectionTitle>{t("models.thinkingLevelMap")}</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  type="button"
                  onClick={() => set("thinkingLevelMap", undefined)}
                  className={styles.clearAllButton}
                >
                  {t("common.clearAll")}
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
        <Field label={t("models.contextWindow")}>
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label={t("models.maxOutputTokens")}>
          <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
        </Field>
      </div>

      <div>
        <SectionTitle>{t("models.costPerMillion")}</SectionTitle>
        <div className={styles.costGrid}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={t(`models.cost.${k}` as "models.cost.input" | "models.cost.output" | "models.cost.cacheRead" | "models.cost.cacheWrite")}>
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
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const savedConfigRef = useRef(JSON.stringify({ providers: {} }));
  const selectDetail = useCallback((next: Selection) => {
    setSelection(next);
    setMobilePane("detail");
  }, []);

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
    setMobilePane("detail");
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
    setMobilePane("detail");
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
    setMobilePane("detail");
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
      <DialogShell
        open
        title={t("models.title")}
        description="~/.pi/agent/models.json"
        onClose={onClose}
        size="xwide"
        mobileMode="fullscreen"
        bodyClassName={styles.shellBody}
        testId="models-config-dialog"
        footer={(
          <div className={styles.footerContent}>
            {saveError && <span className={styles.saveErrorText} role="alert">{saveError}</span>}
            <button type="button" onClick={onClose} className={styles.cancelButton}>
              {t("common.cancel")}
            </button>
            <button type="button" onClick={handleSave} disabled={saving || savedOk || !hasUnsavedChanges}
              className={`${styles.saveButton} ${savedOk ? styles.saveButtonSaved : saving ? styles.saveButtonSaving : styles.saveButtonReady}`}>
              {savedOk && <CheckCircle2 size={16} strokeWidth={2.4} aria-hidden="true" className={styles.saveCheckIcon} />}
              <span>{savedOk ? t("common.saved") : saving ? t("common.saving") : t("common.save")}</span>
            </button>
          </div>
        )}
      >
        <div className={`${styles.layout} ${mobilePane === "detail" ? styles.mobileDetail : styles.mobileList}`}>

          {/* Left: tree */}
          <div className={styles.sidebar} data-testid="models-config-nav">
            <div className={styles.sidebarScroll}>
              <button
                type="button"
                onClick={() => selectDetail({ type: "health" })}
                className={`${styles.healthRow} ${selection?.type === "health" ? styles.treeItemSelected : "hover-bg"}`}
                data-testid="provider-health-nav"
                aria-pressed={selection?.type === "health"}
              >
                <CheckCircle2 className={styles.healthIcon} strokeWidth={1.8} aria-hidden="true" />
                <span className={styles.treeItemText}>{t("providerHealth.title")}</span>
              </button>
              <div className={styles.divider} />
              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => selectDetail({ type: "oauth", providerId: p.id })}
                    className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ""} ${!isSelected ? "hover-bg" : ""}`}
                    aria-pressed={isSelected}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <span className={styles.treeItemText}>{p.name}</span>
                  </button>
                );
              })}

              {/* Active API key providers */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => selectDetail({ type: "apikey", providerId: p.id })}
                    className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ""} ${!isSelected ? "hover-bg" : ""}`}
                    aria-pressed={isSelected}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <span className={styles.treeItemText}>{p.displayName}</span>
                  </button>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                <div className={styles.divider} />
              )}

              {/* Custom providers */}
              {loading ? (
                <div className={styles.loadingText}>{t("common.loading")}</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} className={styles.providerGroup}>
                    {/* Provider row */}
                    <button
                      type="button"
                      onClick={() => selectDetail({ type: "provider", name: pName })}
                      className={`${styles.providerRow} ${isProviderSelected ? styles.providerRowSelected : ""} ${!isProviderSelected ? "hover-bg" : ""}`}
                      aria-pressed={isProviderSelected}
                    >
                      <Cpu size={15} strokeWidth={1.8} aria-hidden="true" className={styles.providerIcon} />
                      <span className={`${styles.providerName} ${isProviderSelected ? styles.providerNameSelected : ""}`}>
                        {pName}
                      </span>
                    </button>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      return (
                        <button
                          type="button"
                          key={i}
                          onClick={() => selectDetail({ type: "model", providerName: pName, index: i })}
                          className={`${styles.modelRow} ${isModelSelected ? styles.modelRowSelected : ""} ${!isModelSelected ? "hover-bg" : ""}`}
                          aria-pressed={isModelSelected}
                        >
                          <span className={`${styles.modelName} ${!m.id ? styles.modelNameEmpty : ""}`}>
                            {m.id || t("models.newModel")}
                          </span>
                          {m.reasoning && (
                            <span className={styles.reasoningBadge}>T</span>
                          )}
                        </button>
                      );
                    })}

                    {/* Add model button */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                      className={`${styles.addModelButton} hover-bg-text`}
                    >
                      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
                      <span className={styles.addModelText}>{t("models.addModel")}</span>
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add provider */}
            <div className={styles.addProviderWrapper}>
              <button type="button" onClick={() => setPickerOpen(true)}
                className={`${styles.addProviderButton} hover-border-accent`}
              >
                <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
                {t("providers.add")}
              </button>
            </div>
          </div>

          {/* Right: detail */}
          <div className={styles.rightPanel} data-testid="models-config-detail">
            <button type="button" className={styles.mobileBack} onClick={() => setMobilePane("list")}>
              <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
              {t("models.back")}
            </button>
            {loading ? null : detailContent ?? (
              <div className={styles.emptyState}>
                <Cpu size={30} strokeWidth={1.6} aria-hidden="true" />
                <strong>{t("models.noneSelected")}</strong>
                <span>{t("models.noneSelectedHint")}</span>
                <button type="button" onClick={() => setPickerOpen(true)}>{t("providers.add")}</button>
              </div>
            )}
          </div>
        </div>
      </DialogShell>
      {pickerOpen && (
        <AddProviderPicker
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id: string) => selectDetail({ type: "oauth", providerId: id })}
          onSelectApiKey={(id: string) => selectDetail({ type: "apikey", providerId: id })}
          onAddCustom={addCustomProvider}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
