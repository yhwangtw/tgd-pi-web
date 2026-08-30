"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  ServerCog,
  X,
} from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import { showToast } from "@/hooks/useToast";
import { useI18n, type MsgKey } from "@/lib/i18n";
import type {
  ManagedActionStatus,
  UpdateBackup,
  UpdateCenterAction,
  UpdateCenterStatus,
  UpdatePreflightCheck,
} from "@/lib/update-center";
import styles from "./UpdateCenterSection.module.css";

interface UpdateConfirmation {
  token: string;
  expiresAt: number;
  action: UpdateCenterAction;
  summary: string;
  impact: string[];
  currentVersion: string;
  targetVersion?: string;
  backup?: UpdateBackup | null;
}

interface PrepareResponse {
  confirmation: UpdateConfirmation;
}

const ACTION_LABELS: Record<UpdateCenterAction, MsgKey> = {
  backup: "updateCenter.action.backup",
  update: "updateCenter.action.update",
  restart: "updateCenter.action.restart",
  rollback: "updateCenter.action.rollback",
};

const CONFIRM_DESCRIPTIONS: Record<UpdateCenterAction, MsgKey> = {
  backup: "updateCenter.confirmDescription.backup",
  update: "updateCenter.confirmDescription.update",
  restart: "updateCenter.confirmDescription.restart",
  rollback: "updateCenter.confirmDescription.rollback",
};

const CHECK_LABELS: Record<UpdatePreflightCheck["id"], MsgKey> = {
  node: "updateCenter.check.node",
  release: "updateCenter.check.release",
  source: "updateCenter.check.source",
  backup: "updateCenter.check.backup",
  workspace: "updateCenter.check.workspace",
  updater: "updateCenter.check.updater",
  restart: "updateCenter.check.restart",
};

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function ActionAvailability({ status }: { status: ManagedActionStatus }) {
  const { t } = useI18n();
  if (status.ready) return <span className={styles.actionReady}>{t("updateCenter.managedReady")}{status.label ? ` · ${status.label}` : ""}</span>;
  const key: MsgKey = status.reason === "invalid_config"
    ? "updateCenter.managedInvalid"
    : status.reason === "not_executable"
      ? "updateCenter.managedUnavailable"
      : "updateCenter.managedMissing";
  return <span className={styles.actionUnavailable}>{t(key)}</span>;
}

function CheckIcon({ state }: { state: UpdatePreflightCheck["state"] }) {
  if (state === "pass") return <Check aria-hidden />;
  if (state === "warning") return <AlertTriangle aria-hidden />;
  return <X aria-hidden />;
}

function managedDetail(status: ManagedActionStatus, t: (key: MsgKey) => string): string {
  if (status.ready) return status.label ? `${t("updateCenter.managedReady")} · ${status.label}` : t("updateCenter.managedReady");
  if (status.reason === "invalid_config") return t("updateCenter.managedInvalid");
  if (status.reason === "not_executable") return t("updateCenter.managedUnavailable");
  return t("updateCenter.managedMissing");
}

function formatCheckDetail(
  check: UpdatePreflightCheck,
  status: UpdateCenterStatus,
  t: (key: MsgKey) => string,
): string {
  switch (check.id) {
    case "node":
      return check.detail;
    case "release":
      return status.latest.tag ?? t("updateCenter.detail.releaseUnavailable");
    case "source":
      return status.current.source === "git"
        ? `${status.current.branch} · ${status.current.head?.slice(0, 7)}`
        : t("updateCenter.releaseArchive");
    case "backup":
      return status.backup.writable
        ? t("updateCenter.freeSpace").replace("{size}", formatBytes(status.backup.freeBytes))
        : t("updateCenter.detail.backupUnavailable");
    case "workspace":
      return status.current.dirty
        ? t("updateCenter.detail.sourceChanged").replace("{count}", String(status.current.changedFiles))
        : t("updateCenter.detail.sourceClean");
    case "updater":
      return managedDetail(status.actions.update, t);
    case "restart":
      return managedDetail(status.actions.restart, t);
  }
}

export function UpdateCenterSection() {
  const { locale, t } = useI18n();
  const [confirmation, setConfirmation] = useState<UpdateConfirmation | null>(null);
  const [busyAction, setBusyAction] = useState<UpdateCenterAction | null>(null);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const updateCenter = useRequestResource<UpdateCenterStatus>(
    "runtime:update-center",
    (signal) => fetchJson("/api/runtime/update", { cache: "no-store" }, signal),
    { staleTimeMs: 60_000, retries: 1 },
  );
  const status = updateCenter.data;

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale === "zh" ? "zh-TW" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }), [locale]);

  const refresh = async () => {
    if (forceRefreshing) return;
    setForceRefreshing(true);
    try {
      await fetchJson<UpdateCenterStatus>("/api/runtime/update?refresh=1", { cache: "no-store" });
      updateCenter.invalidate(true);
      await updateCenter.refresh();
    } catch {
      showToast(t("updateCenter.error.refresh"), { type: "error" });
    } finally {
      setForceRefreshing(false);
    }
  };

  const prepare = async (action: UpdateCenterAction, backupId?: string) => {
    if (busyAction) return;
    setBusyAction(action);
    try {
      const response = await fetchJson<PrepareResponse>("/api/runtime/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "prepare", action, backupId }),
      });
      setConfirmation(response.confirmation);
    } catch {
      showToast(t("updateCenter.error.prepare"), { type: "error" });
    } finally {
      setBusyAction(null);
    }
  };

  const execute = async () => {
    if (!confirmation || busyAction) return;
    const current = confirmation;
    setBusyAction(current.action);
    try {
      await fetchJson<{ ok: boolean }>("/api/runtime/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "execute",
          action: current.action,
          token: current.token,
          backupId: current.backup?.id,
        }),
      });
      setConfirmation(null);
      showToast(t(`updateCenter.success.${current.action}` as MsgKey), { type: "success" });
      if (current.action === "backup") {
        updateCenter.invalidate(true);
        await updateCenter.refresh();
      }
    } catch {
      showToast(t("updateCenter.error.execute"), { type: "error" });
    } finally {
      setBusyAction(null);
    }
  };

  if (updateCenter.loading && !status) {
    return <section className={styles.state}>{t("updateCenter.loading")}</section>;
  }
  if (updateCenter.error && !status) {
    return <section className={styles.state} data-error><span>{updateCenter.error}</span><button type="button" onClick={() => void updateCenter.refresh()}>{t("common.retry")}</button></section>;
  }
  if (!status) return null;

  const updateButtonDisabled = busyAction !== null || !status.actions.update.ready || status.updateAvailable !== true;
  const restartButtonDisabled = busyAction !== null || !status.actions.restart.ready;
  const rollbackButtonDisabled = busyAction !== null || !status.actions.rollback.ready || !status.backup.latest;
  const hasManagedActions = status.actions.update.configured || status.actions.restart.configured || status.actions.rollback.configured;

  return (
    <section className={styles.root} data-testid="update-center">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>{t("updateCenter.eyebrow")}</span>
          <h3>{t("updateCenter.title")}</h3>
          <p>{t("updateCenter.description")}</p>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void refresh()} disabled={updateCenter.refreshing || forceRefreshing}>
          <RefreshCw size={16} strokeWidth={1.8} aria-hidden />
          {updateCenter.refreshing || forceRefreshing ? t("updateCenter.refreshing") : t("updateCenter.refresh")}
        </button>
      </header>

      <div className={styles.versionGrid}>
        <article className={styles.versionCard}>
          <span>{t("updateCenter.current")}</span>
          <strong>{status.current.version}</strong>
          <small>{status.current.source === "git" ? `${status.current.branch} · ${status.current.head?.slice(0, 7)}` : t("updateCenter.releaseArchive")}</small>
        </article>
        <article className={styles.versionCard} data-update={status.updateAvailable === true}>
          <span>{t("updateCenter.latest")}</span>
          <strong>{status.latest.version ?? t("runtime.offline")}</strong>
          <small>{status.updateAvailable === true ? t("updateCenter.available") : status.updateAvailable === false ? t("updateCenter.currentVersion") : t("updateCenter.unknown")}</small>
        </article>
        <article className={styles.versionCard}>
          <span>{t("updateCenter.recovery")}</span>
          <strong>{status.backup.recent.length}</strong>
          <small>{t("updateCenter.freeSpace").replace("{size}", formatBytes(status.backup.freeBytes))}</small>
        </article>
      </div>

      <div className={styles.contentGrid}>
        <section className={styles.preflight}>
          <div className={styles.sectionTitle}>
            <div>
              <h4>{t("updateCenter.preflight")}</h4>
              <span>{status.preflight.ready ? t("updateCenter.preflightReady") : t("updateCenter.preflightNeedsSetup")}</span>
            </div>
            <span className={styles.preflightBadge} data-ready={status.preflight.ready}>{status.preflight.ready ? t("runtime.ready") : t("runtime.needsAttention")}</span>
          </div>
          <ul className={styles.checks}>
            {status.preflight.checks.map((check) => (
              <li key={check.id} data-state={check.state}>
                <span className={styles.checkIcon}><CheckIcon state={check.state} /></span>
                <span><strong>{t(CHECK_LABELS[check.id])}</strong><small>{formatCheckDetail(check, status, t)}</small></span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.release}>
          <div className={styles.sectionTitle}>
            <div>
              <h4>{t("updateCenter.releaseNotes")}</h4>
              <span>{status.latest.publishedAt ? dateFormatter.format(new Date(status.latest.publishedAt)) : t("updateCenter.releaseUnavailable")}</span>
            </div>
            <a href={status.latest.url} target="_blank" rel="noreferrer" aria-label={t("updateCenter.openRelease")}>
              <ExternalLink size={16} strokeWidth={1.8} aria-hidden />
            </a>
          </div>
          {status.latest.notes ? <pre>{status.latest.notes}</pre> : <p>{t("updateCenter.noReleaseNotes")}</p>}
        </section>
      </div>

      <section className={styles.recovery}>
        <div className={styles.sectionTitle}>
          <div>
            <h4>{t("updateCenter.backups")}</h4>
            <span>{t("updateCenter.backupDescription")}</span>
          </div>
          <button type="button" className={styles.secondaryAction} onClick={() => void prepare("backup")} disabled={busyAction !== null || !status.actions.backup.ready}>
            <Archive size={16} strokeWidth={1.8} aria-hidden />
            {busyAction === "backup" ? t("updateCenter.preparing") : t("updateCenter.createBackup")}
          </button>
        </div>
        {status.backup.latest ? (
          <div className={styles.backupRow}>
            <div><strong>{dateFormatter.format(new Date(status.backup.latest.createdAt))}</strong><code title={status.backup.latest.path}>{status.backup.latest.id}</code></div>
            <span>{status.backup.latest.version} · {status.backup.latest.source}{status.backup.latest.dirty ? ` · ${t("updateCenter.withChanges")}` : ""}</span>
          </div>
        ) : <p className={styles.emptyBackup}>{t("updateCenter.noBackups")}</p>}
      </section>

      <section className={styles.actions}>
        <div className={styles.sectionTitle}>
          <div>
            <h4>{t("updateCenter.managedActions")}</h4>
            <span>{hasManagedActions ? t("updateCenter.managedDescription") : t("updateCenter.managedNotConfigured")}</span>
          </div>
        </div>
        <div className={styles.actionGrid}>
          <article>
            <div><ServerCog aria-hidden /><strong>{t("updateCenter.action.update")}</strong></div>
            <ActionAvailability status={status.actions.update} />
            <button type="button" onClick={() => void prepare("update")} disabled={updateButtonDisabled}>{busyAction === "update" ? t("updateCenter.preparing") : t("updateCenter.installUpdate")}</button>
          </article>
          <article>
            <div><RefreshCw aria-hidden /><strong>{t("updateCenter.action.restart")}</strong></div>
            <ActionAvailability status={status.actions.restart} />
            <button type="button" onClick={() => void prepare("restart")} disabled={restartButtonDisabled}>{busyAction === "restart" ? t("updateCenter.preparing") : t("updateCenter.restartNow")}</button>
          </article>
          <article>
            <div><RotateCcw aria-hidden /><strong>{t("updateCenter.action.rollback")}</strong></div>
            <ActionAvailability status={status.actions.rollback} />
            <button type="button" onClick={() => void prepare("rollback", status.backup.latest?.id)} disabled={rollbackButtonDisabled}>{busyAction === "rollback" ? t("updateCenter.preparing") : t("updateCenter.rollbackNow")}</button>
          </article>
        </div>
        <div className={styles.dataImpact}>
          <Check size={16} strokeWidth={1.8} aria-hidden />
          <span>{t("updateCenter.dataPreserved")}</span>
        </div>
      </section>

      <details className={styles.cli}>
        <summary>{t("updateCenter.cliFallback")}</summary>
        <div><span>{t("updateCenter.action.update")}</span><code>{status.commands.update}</code></div>
        <div><span>{t("updateCenter.action.restart")}</span><code>{status.commands.restart}</code></div>
        <div><span>{t("updateCenter.action.rollback")}</span><code>{status.commands.rollback}</code></div>
      </details>

      <DialogShell
        open={Boolean(confirmation)}
        title={confirmation ? t(`updateCenter.confirm.${confirmation.action}` as MsgKey) : t("updateCenter.confirmTitle")}
        description={confirmation ? t(CONFIRM_DESCRIPTIONS[confirmation.action]) : undefined}
        onClose={() => setConfirmation(null)}
        canClose={!busyAction}
        size="compact"
        mobileMode="sheet"
        footer={<>
          <button type="button" className={styles.dialogSecondary} onClick={() => setConfirmation(null)} disabled={Boolean(busyAction)}>{t("common.cancel")}</button>
          <button type="button" className={styles.dialogPrimary} onClick={() => void execute()} disabled={Boolean(busyAction)}>
            {busyAction ? t("updateCenter.running") : confirmation ? t(ACTION_LABELS[confirmation.action]) : t("common.done")}
          </button>
        </>}
      >
        {confirmation && <div className={styles.confirmation}>
          <div className={styles.confirmVersions}>
            <span>{confirmation.currentVersion}</span>
            {confirmation.targetVersion && <><span aria-hidden>→</span><strong>{confirmation.targetVersion}</strong></>}
          </div>
          <ul>{confirmation.impact.map((item) => <li key={item}>{t(`updateCenter.impact.${item}` as MsgKey)}</li>)}</ul>
          {confirmation.backup && <code>{confirmation.backup.id}</code>}
          <p>{t("updateCenter.confirmExpiry")}</p>
        </div>}
      </DialogShell>
    </section>
  );
}
