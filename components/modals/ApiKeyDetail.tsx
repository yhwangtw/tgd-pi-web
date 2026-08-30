"use client";

import { useState, useEffect, useCallback } from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { ApiKeyProvider } from "./models-config-types";
import { Field, SecretTextInput, SectionTitle } from "./models-config-forms";
import styles from "./ApiKeyDetail.module.css";

export function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() })
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  const saveBtnClass = [
    styles.saveBtn,
    savedOk ? styles.saveBtnSuccess : apiKey.trim() ? styles.saveBtnActive : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <SectionTitle>{t("apiKey.title")}</SectionTitle>
        <div className={styles.statusDotContainer}>
          <span className={`${styles.statusDot} ${provider.configured ? styles.statusDotConfigured : styles.statusDotUnconfigured}`} aria-hidden="true" />
          <span className={`${styles.statusText} ${provider.configured ? styles.statusTextConfigured : styles.statusTextUnconfigured}`}>
            {provider.configured ? t("apiKey.configured") : t("apiKey.notConfigured")}
          </span>
        </div>
      </div>

      <p className={styles.description}>
        {provider.configured
          ? t("apiKey.stored")
          : t("apiKey.enableModels")
              .replace("{provider}", provider.displayName)
              .replace("{count}", String(provider.modelCount))}
      </p>

      <Field label={t("apiKey.title")}>
        <div className={styles.inputRow}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
            placeholder={provider.configured ? t("apiKey.replacePlaceholder") : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            ariaLabel={t("apiKey.inputLabel").replace("{provider}", provider.displayName)}
            mono
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            className={saveBtnClass}
          >
            {savedOk && (
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            )}
            {savedOk ? t("common.saved") : saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </Field>

      {error && <p className={styles.errorText} role="alert">{error}</p>}

      {provider.configured && (
        <button
          type="button"
          onClick={handleRemove}
          disabled={removing}
          className={styles.disconnectBtn}
        >
          {removing ? t("apiKey.removing") : t("oauth.disconnect")}
        </button>
      )}
    </div>
  );
}
