"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PackageCenterEntry } from "@/lib/package-center";
import type { PackageMutationAction } from "@/lib/package-confirmation";
import { useI18n } from "@/lib/i18n";
import { showToast } from "@/hooks/useToast";
import styles from "./PackageCenter.module.css";

interface UpdateEntry { source: string; displayName: string; type: "npm" | "git"; scope: "user" | "project" }
interface PendingMutation { action: PackageMutationAction; source: string; token: string; expiresAt: number }

export function PackageCenter({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [packages, setPackages] = useState<PackageCenterEntry[]>([]);
  const [updates, setUpdates] = useState<UpdateEntry[]>([]);
  const [source, setSource] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!sessionId) return;
    setBusy("load");
    setError("");
    try {
      const response = await fetch(`/api/packages?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { packages?: PackageCenterEntry[]; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setPackages(data.packages ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const request = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/packages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sessionId }),
    });
    const data = await response.json() as {
      packages?: PackageCenterEntry[];
      updates?: UpdateEntry[];
      confirmation?: { token: string; expiresAt: number };
      action?: PackageMutationAction;
      source?: string;
      reloadError?: string;
      error?: string;
    };
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }, [sessionId]);

  const prepare = useCallback(async (action: PackageMutationAction, packageSource: string) => {
    if (!sessionId || busy) return;
    setBusy(`prepare:${action}:${packageSource}`);
    setError("");
    try {
      const data = await request({ phase: "prepare", action, source: packageSource });
      if (!data.confirmation || !data.action || !data.source) throw new Error("Package confirmation was not created");
      setPending({ action: data.action, source: data.source, ...data.confirmation });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      showToast(message, { type: "error" });
    } finally {
      setBusy(null);
    }
  }, [busy, request, sessionId]);

  const execute = useCallback(async () => {
    if (!pending || !sessionId || busy) return;
    setBusy(`execute:${pending.action}:${pending.source}`);
    setError("");
    try {
      const data = await request({
        phase: "execute",
        action: pending.action,
        source: pending.source,
        confirmationToken: pending.token,
      });
      setPackages(data.packages ?? []);
      setSource("");
      setPending(null);
      if (data.reloadError) showToast(`${t("packages.changedReloadFailed")}: ${data.reloadError}`, { type: "error" });
      else showToast(t("packages.changed"));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setPending(null);
      showToast(message, { type: "error" });
    } finally {
      setBusy(null);
    }
  }, [busy, pending, request, sessionId, t]);

  const checkUpdates = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy("check");
    setError("");
    try {
      const data = await request({ action: "check_updates" });
      setPackages(data.packages ?? []);
      setUpdates(data.updates ?? []);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      showToast(message, { type: "error" });
    } finally {
      setBusy(null);
    }
  }, [busy, request, sessionId]);

  const updateSources = useMemo(() => new Set(updates.map((update) => update.source)), [updates]);

  if (!sessionId) return <div className={styles.state}>{t("packages.noSession")}</div>;

  return (
    <div className={styles.root} data-testid="package-center">
      <section className={styles.security}>
        <strong>{t("packages.securityTitle")}</strong>
        <p>{t("packages.securityBody")}</p>
      </section>

      <section className={styles.installCard}>
        <div className={styles.sectionTitle}>{t("packages.install")}</div>
        <div className={styles.formRow}>
          <input value={source} onChange={(event) => { setSource(event.target.value); setPending(null); }}
            placeholder="npm:@scope/package or package@version"
            className={styles.sourceInput} aria-label={t("packages.source")} />
          <span className={styles.userScope}>{t("packages.scope.user")}</span>
          <button type="button" className={styles.primaryButton} disabled={!source.trim() || !acknowledged || !!busy}
            onClick={() => void prepare("install", source.trim())}>
            {t("packages.reviewInstall")}
          </button>
        </div>
        <label className={styles.acknowledge}>
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>{t("packages.acknowledge")}</span>
        </label>
        <p className={styles.scopeNote}>{t("packages.safeScopeNote")}</p>
      </section>

      {pending && (
        <section className={styles.confirmation} role="alert">
          <div>
            <strong>{t(`packages.confirm.${pending.action}`)}</strong>
            <code>{pending.source}</code>
            <span>{t("packages.confirmHint")}</span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={pending.action === "remove" ? styles.dangerButton : styles.primaryButton}
              disabled={!!busy || Date.now() >= pending.expiresAt} onClick={() => void execute()}>
              {t(`packages.confirmAction.${pending.action}`)}
            </button>
            <button type="button" className={styles.secondaryButton} disabled={!!busy} onClick={() => setPending(null)}>{t("common.cancel")}</button>
          </div>
        </section>
      )}

      <div className={styles.listHeader}>
        <div><strong>{t("packages.installed")}</strong><span>{packages.length}</span></div>
        <button type="button" className={styles.secondaryButton} disabled={!!busy} onClick={() => void checkUpdates()}>
          {busy === "check" ? t("packages.checking") : t("packages.checkUpdates")}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {busy === "load" && packages.length === 0 ? <div className={styles.state}>{t("common.loading")}</div> : packages.length === 0 ? (
        <div className={styles.empty}>{t("packages.empty")}</div>
      ) : (
        <div className={styles.list}>
          {packages.map((item) => {
            const hasUpdate = updateSources.has(item.source);
            return (
              <article key={`${item.scope}:${item.source}`} className={styles.packageCard}>
                <div className={styles.packageMain}>
                  <div className={styles.packageTitle}>
                    <strong>{item.name ?? item.source}</strong>
                    {item.version && <code>v{item.version}</code>}
                  </div>
                  {item.name && <code className={styles.source}>{item.source}</code>}
                  <div className={styles.meta}>
                    <span>{item.scope === "project" ? t("packages.scope.projectShort") : t("packages.scope.userShort")}</span>
                    <span>{item.kind}</span>
                    {item.pinned && <span>{t("packages.pinned")}</span>}
                    {item.filtered && <span>{t("packages.filtered")}</span>}
                    {!item.installed && <span className={styles.missing}>{t("packages.missing")}</span>}
                    {item.resources.map((resource) => <span key={resource}>{resource}</span>)}
                  </div>
                </div>
                <div className={styles.actions}>
                  {item.mutable ? (
                    <>
                      <button type="button" className={styles.secondaryButton} disabled={!!busy || item.pinned}
                        title={item.pinned ? t("packages.pinnedHint") : undefined}
                        onClick={() => void prepare("update", item.source)}>
                        {hasUpdate ? t("packages.updateAvailable") : t("packages.update")}
                      </button>
                      <button type="button" className={styles.removeButton} disabled={!!busy}
                        onClick={() => void prepare("remove", item.source)}>{t("packages.remove")}</button>
                    </>
                  ) : <span className={styles.readOnly}>{t("packages.readOnly")}</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
