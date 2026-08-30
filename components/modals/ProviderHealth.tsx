"use client";

import { useMemo, useState } from "react";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import type { ProviderHealthEntry, ProviderHealthReport } from "@/lib/provider-health";
import { useI18n } from "@/lib/i18n";
import { ProviderIcon } from "./ProviderIcon";
import styles from "./ProviderHealth.module.css";

function StatusBadge({ status }: { status: ProviderHealthEntry["status"] }) {
  const { t } = useI18n();
  const labels = {
    ready: t("providerHealth.ready"),
    needs_auth: t("providerHealth.needsAuth"),
    warning: t("providerHealth.warning"),
    invalid: t("providerHealth.invalid"),
  };
  return <span className={styles.status} data-status={status}>{labels[status]}</span>;
}

export function ProviderHealth() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<"attention" | "configured" | "all">("attention");
  const resource = useRequestResource<ProviderHealthReport>(
    "provider-health",
    (signal) => fetchJson("/api/provider-health", { cache: "no-store" }, signal),
    { staleTimeMs: 30_000, retries: 1 },
  );
  const report = resource.data;

  const providers = useMemo(() => {
    const all = report?.providers ?? [];
    if (filter === "attention") {
      const attention = all.filter((provider) => provider.status !== "ready" && provider.status !== "needs_auth");
      return attention.length > 0 ? attention : all.filter((provider) => provider.status === "ready");
    }
    if (filter === "configured") return all.filter((provider) => provider.status !== "needs_auth");
    return all;
  }, [filter, report]);

  if (resource.loading && !report) return <div className={styles.state}>{t("providerHealth.checking")}</div>;
  if (resource.error && !report) return <div className={`${styles.state} ${styles.error}`}>{resource.error}<button type="button" onClick={() => void resource.refresh()}>{t("common.refresh")}</button></div>;

  return (
    <div className={styles.root} data-testid="provider-health">
      <div className={styles.intro}>
        <div>
          <h2>{t("providerHealth.title")}</h2>
          <p>{t("providerHealth.description")}</p>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void resource.refresh()} disabled={resource.refreshing}>
          {resource.refreshing ? t("providerHealth.checking") : t("providerHealth.recheck")}
        </button>
      </div>

      {report && (
        <>
          <div className={styles.summary}>
            <div><strong>{report.summary.ready}</strong><span>{t("providerHealth.ready")}</span></div>
            <div><strong>{report.summary.warning + report.summary.invalid}</strong><span>{t("providerHealth.attention")}</span></div>
            <div><strong>{report.summary.needsAuth}</strong><span>{t("providerHealth.notConfigured")}</span></div>
            <div><strong>{report.summary.total}</strong><span>{t("providerHealth.total")}</span></div>
          </div>

          <section className={styles.coverage} aria-labelledby="provider-health-coverage-title">
            <div className={styles.coverageIntro}>
              <strong id="provider-health-coverage-title">{t("providerHealth.coverageTitle")}</strong>
              <span>{t("providerHealth.coverageHint")}</span>
            </div>
            <div className={styles.coverageGrid}>
              <div>
                <span>{t("providerHealth.credentialReadiness")}</span>
                <strong data-state={report.coverage.credentialReadiness}>{t("providerHealth.checked")}</strong>
              </div>
              <div>
                <span>{t("providerHealth.localCatalog")}</span>
                <strong data-state={report.coverage.localCatalog}>{t("providerHealth.checked")}</strong>
              </div>
              <div>
                <span>{t("providerHealth.quotaAndBilling")}</span>
                <strong data-state={report.coverage.quotaAndBilling}>{t("providerHealth.unknown")}</strong>
              </div>
              <div>
                <span>{t("providerHealth.upstreamAvailability")}</span>
                <strong data-state={report.coverage.upstreamAvailability}>{t("providerHealth.notTested")}</strong>
              </div>
            </div>
          </section>

          <div className={styles.toolbar} role="tablist" aria-label={t("providerHealth.filter")}>
            {(["attention", "configured", "all"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={filter === value}
                className={filter === value ? styles.filterActive : styles.filter}
                onClick={() => setFilter(value)}>
                {t(`providerHealth.filter.${value}`)}
              </button>
            ))}
            <span className={styles.checkedAt}>{new Date(report.checkedAt).toLocaleTimeString()}</span>
          </div>

          {report.runtimeError && <div className={styles.runtimeError}>{report.runtimeError}</div>}

          <div className={styles.list}>
            {providers.length === 0 ? <div className={styles.state}>{t("providerHealth.none")}</div> : providers.map((provider) => (
              <article key={provider.id} className={styles.provider}>
                <ProviderIcon id={provider.id} size={22} />
                <div className={styles.providerMain}>
                  <div className={styles.providerTitle}>
                    <strong>{provider.name}</strong>
                    <code>{provider.id}</code>
                  </div>
                  <div className={styles.meta}>
                    <span>{provider.availableModelCount}/{provider.modelCount} {t("providerHealth.models")}</span>
                    {(provider.authSource || provider.configuredSource) && <span>{provider.authSource ?? provider.configuredSource}</span>}
                    {provider.authType && <span>{provider.authType === "oauth" ? "OAuth" : t("apiKey.title")}</span>}
                  </div>
                  {provider.issue && <p className={styles.issue}>{provider.issue}</p>}
                </div>
                <StatusBadge status={provider.status} />
              </article>
            ))}
          </div>
          <p className={styles.note}>{t("providerHealth.note")}</p>
        </>
      )}
    </div>
  );
}
