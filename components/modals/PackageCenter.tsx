"use client";

import { useCallback, useMemo, useState } from "react";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import type {
  PackageCenterEntry,
  PackageMutationPreview,
  PackagePermissionId,
} from "@/lib/package-center";
import type { PackageMutationAction } from "@/lib/package-confirmation";
import { useI18n, type MsgKey } from "@/lib/i18n";
import { showToast } from "@/hooks/useToast";
import styles from "./PackageCenter.module.css";

interface UpdateEntry { source: string; displayName: string; type: "npm" | "git"; scope: "user" | "project" }
interface PendingMutation {
  action: PackageMutationAction;
  source: string;
  token: string;
  expiresAt: number;
  preview: PackageMutationPreview;
}
type PackageResource = { packages?: PackageCenterEntry[]; error?: string };
const EMPTY_PACKAGES: PackageCenterEntry[] = [];

const PERMISSION_KEYS = {
  hostCode: "packages.permission.hostCode",
  filesystem: "packages.permission.filesystem",
  process: "packages.permission.process",
  network: "packages.permission.network",
  credentials: "packages.permission.credentials",
  modelInstructions: "packages.permission.modelInstructions",
  appearance: "packages.permission.appearance",
  installScripts: "packages.permission.installScripts",
  binaries: "packages.permission.binaries",
  dependencies: "packages.permission.dependencies",
} as const satisfies Record<PackagePermissionId, MsgKey>;

export function PackageCenter({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [updates, setUpdates] = useState<UpdateEntry[]>([]);
  const [source, setSource] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const packageKey = sessionId ? `packages:${sessionId}` : null;
  const resource = useRequestResource<PackageResource>(
    packageKey,
    (signal) => fetchJson(`/api/packages?sessionId=${encodeURIComponent(sessionId ?? "")}`, { cache: "no-store" }, signal),
    { enabled: Boolean(sessionId), staleTimeMs: 15_000, retries: 1 },
  );
  const packages = resource.data?.packages ?? EMPTY_PACKAGES;
  const { invalidate, refresh } = resource;

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
      preview?: PackageMutationPreview;
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
      if (!data.confirmation || !data.action || !data.source || !data.preview) throw new Error("Package confirmation was not created");
      setPending({ action: data.action, source: data.source, preview: data.preview, ...data.confirmation });
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
      invalidate();
      await refresh();
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
  }, [busy, invalidate, pending, refresh, request, sessionId, t]);

  const checkUpdates = useCallback(async () => {
    if (!sessionId || busy) return;
    setBusy("check");
    setError("");
    try {
      const data = await request({ action: "check_updates" });
      invalidate();
      await refresh();
      setUpdates(data.updates ?? []);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      showToast(message, { type: "error" });
    } finally {
      setBusy(null);
    }
  }, [busy, invalidate, refresh, request, sessionId]);

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
            placeholder={t("packages.sourcePlaceholder")}
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
        <section className={styles.confirmation} role="alert" data-testid="package-permission-preview">
          <div className={styles.previewMain}>
            <div className={styles.previewHeading}>
              <strong>{t(`packages.confirm.${pending.action}`)}</strong>
              <code>{pending.source}</code>
            </div>
            {(pending.preview.target ?? pending.preview.current) && (() => {
              const inspection = pending.preview.target ?? pending.preview.current!;
              return (
                <div className={styles.previewDetails}>
                  <div className={styles.previewPackage}>
                    <strong>{inspection.name}</strong>
                    <code>v{inspection.version}</code>
                    {inspection.publisher && <span>{t("packages.publisher")}: {inspection.publisher}</span>}
                  </div>
                  {inspection.description && <p>{inspection.description}</p>}
                  {pending.action === "update" && pending.preview.current && pending.preview.target && (
                    <p>{t("packages.versionChange")}: v{pending.preview.current.version} → v{pending.preview.target.version}</p>
                  )}
                  <div className={styles.previewFacts}>
                    {inspection.resources.map((resource) => <span key={resource}>{resource}</span>)}
                    <span>{inspection.dependencyCount} {t("packages.runtimeDependencies")}</span>
                    <span>{inspection.peerDependencyCount} {t("packages.peerDependencies")}</span>
                    {inspection.unpackedSize !== undefined && <span>{Math.ceil(inspection.unpackedSize / 1024)} KB</span>}
                  </div>
                  <div className={styles.permissionReview}>
                    <span className={styles.permissionLabel}>{t("packages.declaredPermissions")}</span>
                    <div className={styles.permissionChips}>
                      {inspection.permissions.map((permission) => (
                        <span key={permission.id} className={styles.permissionChip} data-level={permission.level}>
                          {t(PERMISSION_KEYS[permission.id])}{permission.count > 1 ? ` ×${permission.count}` : ""}
                        </span>
                      ))}
                      {inspection.permissions.length === 0 && <span className={styles.noChange}>{t("packages.noDeclaredPermissions")}</span>}
                    </div>
                  </div>
                  {pending.preview.addedPermissions.length > 0 ? (
                    <div className={styles.permissionReview}>
                      <span className={styles.permissionLabel}>{t("packages.newPermissions")}</span>
                      <div className={styles.permissionChips}>
                        {pending.preview.addedPermissions.map((permission) => (
                          <span key={permission} className={styles.permissionChip} data-level="new">{t(PERMISSION_KEYS[permission])}</span>
                        ))}
                      </div>
                    </div>
                  ) : pending.action === "update" && <span className={styles.noChange}>{t("packages.noNewPermissions")}</span>}
                  {inspection.lifecycleScripts.length > 0 && (
                    <div className={styles.scriptWarning}>
                      <strong>{t("packages.installScriptsWarning")}</strong>
                      <code>{inspection.lifecycleScripts.join(", ")}</code>
                    </div>
                  )}
                  {inspection.integrity && <code className={styles.integrity} title={inspection.integrity}>{t("packages.integrity")}: {inspection.integrity}</code>}
                </div>
              );
            })()}
            <span className={styles.confirmHint}>{t("packages.confirmHint")}</span>
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

      {(error || resource.error) && <div className={styles.error} role="alert"><span>{error || resource.error}</span>{resource.error && <button type="button" onClick={() => void resource.refresh()}>{t("common.retry")}</button>}</div>}
      {resource.loading && packages.length === 0 ? <div className={styles.state}>{t("common.loading")}</div> : packages.length === 0 ? (
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
