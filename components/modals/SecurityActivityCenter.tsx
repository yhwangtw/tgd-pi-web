"use client";

import { useMemo, useState } from "react";
import { Download, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { IconButton } from "@/components/ui/IconButton";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import { showToast } from "@/hooks/useToast";
import { useI18n, type MsgKey } from "@/lib/i18n";
import type { SecurityActivityCategory, SecurityActivityEntry, SecurityActivityOutcome } from "@/lib/security-activity";
import styles from "./SecurityActivityCenter.module.css";

interface ActivityResponse {
  entries?: SecurityActivityEntry[];
  total?: number;
  retentionDays?: number;
  error?: string;
}

const CATEGORY_ORDER: SecurityActivityCategory[] = ["package", "mcp", "skill", "snapshot", "extension", "update", "security"];
const OUTCOME_ORDER: SecurityActivityOutcome[] = ["success", "reviewed", "denied", "failure"];
const EMPTY_ACTIVITY_ENTRIES: SecurityActivityEntry[] = [];

export function SecurityActivityCenter() {
  const { locale, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<SecurityActivityCategory | "all">("all");
  const [outcome, setOutcome] = useState<SecurityActivityOutcome | "all">("all");
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const activity = useRequestResource<ActivityResponse>(
    "security-activity:1000",
    (signal) => fetchJson("/api/security/activity?limit=1000", { cache: "no-store" }, signal),
    { staleTimeMs: 15_000, retries: 1 },
  );
  const entries = activity.data?.entries ?? EMPTY_ACTIVITY_ENTRIES;
  const retentionDays = activity.data?.retentionDays ?? 90;

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (outcome !== "all" && entry.outcome !== outcome) return false;
      if (!normalized) return true;
      return [entry.summary, entry.target, entry.action, entry.cwd]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized));
    });
  }, [category, entries, outcome, query]);

  const exportEntries = () => {
    const blob = new Blob([`${JSON.stringify({ exportedAt: new Date().toISOString(), retentionDays, entries: filtered }, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pi-security-activity-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast(t("securityActivity.exported"), { type: "success" });
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/security/activity", { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setConfirmClear(false);
      activity.invalidate(true);
      await activity.refresh();
      showToast(t("securityActivity.cleared"), { type: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale === "zh" ? "zh-TW" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }), [locale]);

  return (
    <div className={styles.root} data-testid="security-activity-center">
      <section className={styles.hero}>
        <div className={styles.heroIcon}><ShieldCheck size={22} strokeWidth={1.8} aria-hidden /></div>
        <div className={styles.heroCopy}>
          <h2>{t("securityActivity.title")}</h2>
          <p>{t("securityActivity.description").replace("{days}", String(retentionDays))}</p>
        </div>
        <div className={styles.heroCount}>
          <strong>{entries.length}</strong>
          <span>{t("securityActivity.events")}</span>
        </div>
      </section>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={15} strokeWidth={1.8} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("securityActivity.search")} />
        </label>
        <select aria-label={t("securityActivity.category")} value={category} onChange={(event) => setCategory(event.target.value as SecurityActivityCategory | "all")}>
          <option value="all">{t("securityActivity.allCategories")}</option>
          {CATEGORY_ORDER.map((value) => <option value={value} key={value}>{t(`securityActivity.category.${value}` as MsgKey)}</option>)}
        </select>
        <select aria-label={t("securityActivity.outcome")} value={outcome} onChange={(event) => setOutcome(event.target.value as SecurityActivityOutcome | "all")}>
          <option value="all">{t("securityActivity.allOutcomes")}</option>
          {OUTCOME_ORDER.map((value) => <option value={value} key={value}>{t(`securityActivity.outcome.${value}` as MsgKey)}</option>)}
        </select>
        <IconButton
          className={styles.refreshButton}
          size="compact"
          variant="surface"
          label={t("securityActivity.refresh")}
          icon={<RefreshCw strokeWidth={1.8} />}
          onClick={() => void activity.refresh()}
          disabled={activity.loading || activity.refreshing}
        />
        <button type="button" className={styles.secondaryButton} onClick={exportEntries} disabled={filtered.length === 0}>
          <Download size={15} strokeWidth={1.8} aria-hidden />
          {t("securityActivity.export")}
        </button>
        <button type="button" className={styles.dangerButton} onClick={() => setConfirmClear(true)} disabled={entries.length === 0}>
          <Trash2 size={15} strokeWidth={1.8} aria-hidden />
          {t("securityActivity.clear")}
        </button>
      </div>

      <div className={styles.resultMeta}>
        <span>{t("securityActivity.showing").replace("{count}", String(filtered.length))}</span>
        {activity.updatedAt && <time dateTime={new Date(activity.updatedAt).toISOString()}>{t("common.lastUpdated").replace("{time}", dateFormatter.format(activity.updatedAt))}</time>}
      </div>
      {activity.error && <div className={styles.requestError} role="alert"><span>{activity.error}</span><button type="button" onClick={() => void activity.refresh()}>{t("common.retry")}</button></div>}
      {activity.loading && entries.length === 0 ? (
        <div className={styles.state}>{t("common.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>
          <ShieldCheck size={24} strokeWidth={1.6} aria-hidden />
          <strong>{t("securityActivity.emptyTitle")}</strong>
          <span>{entries.length ? t("securityActivity.emptyFiltered") : t("securityActivity.emptyBody")}</span>
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.map((entry) => (
            <article className={styles.entry} key={entry.id} data-outcome={entry.outcome}>
              <div className={styles.entryMarker} />
              <div className={styles.entryBody}>
                <div className={styles.entryTop}>
                  <div className={styles.badges}>
                    <span className={styles.category}>{t(`securityActivity.category.${entry.category}` as MsgKey)}</span>
                    <span className={styles.outcome} data-outcome={entry.outcome}>{t(`securityActivity.outcome.${entry.outcome}` as MsgKey)}</span>
                  </div>
                  <time dateTime={entry.timestamp}>{dateFormatter.format(new Date(entry.timestamp))}</time>
                </div>
                <strong className={styles.summary}>{entry.summary}</strong>
                {entry.target && <code className={styles.target} title={entry.target}>{entry.target}</code>}
                {(entry.cwd || entry.sessionId) && <div className={styles.context}>
                  {entry.cwd && <span title={entry.cwd}>{entry.cwd}</span>}
                  {entry.sessionId && <span>{t("securityActivity.session")} {entry.sessionId.slice(0, 8)}</span>}
                </div>}
                {entry.details && Object.keys(entry.details).length > 0 && <details className={styles.details}>
                  <summary>{t("securityActivity.details")}</summary>
                  <pre>{JSON.stringify(entry.details, null, 2)}</pre>
                </details>}
              </div>
            </article>
          ))}
        </div>
      )}

      <DialogShell
        open={confirmClear}
        title={t("securityActivity.clearTitle")}
        description={t("securityActivity.clearDescription")}
        onClose={() => setConfirmClear(false)}
        canClose={!busy}
        size="compact"
        mobileMode="sheet"
        footer={<>
          <button type="button" className={styles.dialogSecondary} disabled={busy} onClick={() => setConfirmClear(false)}>{t("common.cancel")}</button>
          <button type="button" className={styles.dialogDanger} disabled={busy} onClick={() => void clear()}>{busy ? t("securityActivity.clearing") : t("securityActivity.clearConfirm")}</button>
        </>}
      >
        <p className={styles.clearNote}>{t("securityActivity.clearNote")}</p>
      </DialogShell>
    </div>
  );
}
