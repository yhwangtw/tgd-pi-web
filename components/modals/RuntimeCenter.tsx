"use client";

import { useState } from "react";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
import { showToast } from "@/hooks/useToast";
import { useI18n } from "@/lib/i18n";
import type { CapabilityFoundation, CapabilityTrust, CapabilityWebSupport } from "@/lib/capabilities";
import type { RuntimeStatusReport } from "@/lib/runtime-status";
import { Download } from "lucide-react";
import { UpdateCenterSection } from "./UpdateCenterSection";
import styles from "./RuntimeCenter.module.css";

function StateBadge({ current, unavailable = false, labels }: {
  current: boolean | null;
  unavailable?: boolean;
  labels: { unavailable: string; unknown: string; current: string; update: string };
}) {
  const state = unavailable ? "unavailable" : current === null ? "unknown" : current ? "current" : "update";
  const label = unavailable ? labels.unavailable : current === null ? labels.unknown : current ? labels.current : labels.update;
  return <span className={styles.badge} data-state={state}>{label}</span>;
}

export function RuntimeCenter() {
  const { locale, t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const runtime = useRequestResource<RuntimeStatusReport>(
    "runtime:status",
    (signal) => fetchJson("/api/runtime/status", { cache: "no-store" }, signal),
    { staleTimeMs: 60_000, retries: 1 },
  );
  const report = runtime.data;

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => showToast(t("runtime.commandCopied"), { type: "success" }));
  };

  const exportDiagnostics = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const response = await fetch("/api/diagnostics", {
        method: "POST",
        headers: { "X-Pi-Diagnostics-Consent": "export" },
      });
      const body = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const root = document.documentElement;
      const client = {
        locale,
        viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        appearance: {
          uiStyle: root.dataset.uiStyle,
          skin: root.dataset.skin,
          theme: root.dataset.theme,
          fontSize: root.dataset.fontSize,
          fontFamily: root.dataset.fontFamily,
        },
      };
      const blob = new Blob([`${JSON.stringify({ ...body, client }, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pi-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast(t("runtime.diagnosticsExported"), { type: "success" });
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : String(caught), { type: "error" });
    } finally {
      setExporting(false);
    }
  };

  if (runtime.loading) return <div className={styles.state}>{t("runtime.checking")}</div>;
  if (runtime.error && !report) return <div className={styles.state} data-error>{runtime.error}<button type="button" onClick={() => void runtime.refresh()}>{t("runtime.retry")}</button></div>;
  if (!report) return null;

  const badgeLabels = {
    unavailable: t("runtime.unavailable"),
    unknown: t("runtime.unknown"),
    current: t("runtime.current"),
    update: t("runtime.updateAvailable"),
  };
  const warningLabel = (warning: string) => {
    if (warning.startsWith("Single-user boundary:")) return t("runtime.warningBoundary");
    if (warning.startsWith("Host-process isolation:")) return t("runtime.warningIsolation");
    if (warning.startsWith("Development mode")) return t("runtime.warningDevelopment");
    if (warning.startsWith("The built-in access gate")) return t("runtime.warningAccess");
    if (warning.startsWith("Set a separate PIWEB_SESSION_SECRET")) return t("runtime.warningSecret");
    return warning;
  };
  const foundationLabels: Record<CapabilityFoundation, string> = {
    "pi-sdk": t("runtime.capabilityFoundationSdk"),
    "pi-extension-api": t("runtime.capabilityFoundationExtension"),
    "pi-package-format": t("runtime.capabilityFoundationPackage"),
    "pi-web": t("runtime.capabilityFoundationWeb"),
  };
  const supportLabels: Record<CapabilityWebSupport, string> = {
    native: t("runtime.capabilityNative"),
    adapted: t("runtime.capabilityAdapted"),
  };
  const trustLabels: Record<CapabilityTrust, string> = {
    none: t("runtime.capabilityTrustNone"),
    workspace: t("runtime.capabilityTrustWorkspace"),
    decision: t("runtime.capabilityTrustDecision"),
    host: t("runtime.capabilityTrustHost"),
    endpoint: t("runtime.capabilityTrustEndpoint"),
    operator: t("runtime.capabilityTrustOperator"),
  };

  return (
    <div className={styles.root}>
      <div className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>{t("runtime.eyebrow")}</div>
          <h2>{t("runtime.title")}</h2>
          <p>{t("runtime.description")}</p>
        </div>
        <div className={styles.heroActions}>
          <button type="button" className={styles.refresh} onClick={() => void runtime.refresh()} disabled={runtime.refreshing}>{runtime.refreshing ? t("runtime.checking") : t("runtime.refresh")}</button>
          <button type="button" className={styles.refresh} onClick={() => void exportDiagnostics()} disabled={exporting}>
            <Download size={15} strokeWidth={1.8} aria-hidden />
            {exporting ? t("runtime.exportingDiagnostics") : t("runtime.exportDiagnostics")}
          </button>
        </div>
      </div>
      <div className={styles.grid}>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>{t("runtime.web")}</span><StateBadge current labels={badgeLabels} /></div>
          <strong>{report.web.version}</strong>
          <small>{t("runtime.webHint")}</small>
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>{t("runtime.embedded")}</span><StateBadge current={report.embeddedPi.current} labels={badgeLabels} /></div>
          <strong>{report.embeddedPi.version}</strong>
          <small>{report.embeddedPi.package}</small>
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>{t("runtime.globalCli")}</span><StateBadge current={report.globalCli.current} unavailable={!report.globalCli.available} labels={badgeLabels} /></div>
          <strong>{report.globalCli.version ?? t("runtime.cliMissing")}</strong>
          <small>{t("runtime.cliHint")}</small>
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>{t("runtime.latest")}</span><StateBadge current={report.latest.version ? true : null} labels={badgeLabels} /></div>
          <strong>{report.latest.version ?? t("runtime.offline")}</strong>
          <a href={report.latest.releaseUrl} target="_blank" rel="noreferrer">{t("runtime.releases")} ↗</a>
        </article>
      </div>
      <UpdateCenterSection />
      <section className={styles.capabilities}>
        <div className={styles.capabilityIntro}>
          <div>
            <span className={styles.eyebrow}>{t("runtime.capabilityEyebrow")}</span>
            <h3>{t("runtime.capabilityTitle")}</h3>
          </div>
          <p>{t("runtime.capabilityDescription")}</p>
        </div>
        <ul className={styles.capabilityGrid}>
          {report.capabilities.capabilities.map((capability) => (
            <li key={capability.id} className={styles.capabilityCard}>
              <div className={styles.capabilityTitle}>
                <strong>{capability.title[locale]}</strong>
                <span>{t("runtime.capabilityPackaged")}</span>
              </div>
              <p>{capability.summary[locale]}</p>
              <div className={styles.capabilityMeta}>
                <span>{foundationLabels[capability.foundation]}</span>
                <span>{supportLabels[capability.webSupport]}</span>
                <span data-positive={!capability.globalPiCliRequired}>
                  {capability.globalPiCliRequired ? t("runtime.capabilityCliRequired") : t("runtime.capabilityNoCli")}
                </span>
                <span data-attention={capability.backgroundServerRequired}>
                  {capability.backgroundServerRequired ? t("runtime.capabilityServerRequired") : t("runtime.capabilityNormalRuntime")}
                </span>
                <span>{trustLabels[capability.trust]}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.deployment} data-ready={report.deployment.remoteReady}>
        <div className={styles.deploymentHeader}>
          <div>
            <span className={styles.eyebrow}>{t("runtime.safety")}</span>
            <h3>{t("runtime.boundary")}</h3>
          </div>
          <span className={styles.remoteBadge}>
            {report.deployment.remoteReady ? t("runtime.remoteReady") : t("runtime.localOnly")}
          </span>
        </div>
        <div className={styles.safetyChecks}>
          <span data-ready={report.deployment.webCliIndependent}><strong>{t("runtime.ready")}</strong>{t("runtime.embeddedReady")}</span>
          <span data-ready={report.deployment.safetyGuard}><strong>{t("runtime.ready")}</strong>{t("runtime.safetyGuardReady")}</span>
          <span data-ready={report.deployment.scopedAuthorizationTtlSeconds > 0}><strong>{t("runtime.ready")}</strong>{t("runtime.scopedApproval")} · {Math.round(report.deployment.scopedAuthorizationTtlSeconds / 60)} {t("runtime.minutes")}</span>
          <span data-ready={false}><strong>{t("runtime.hostBoundary")}</strong>{t("runtime.toolIsolation")}</span>
          <span data-ready={report.deployment.accessGate}><strong>{report.deployment.accessGate ? t("runtime.ready") : t("runtime.needsAttention")}</strong>{t("runtime.accessGate")} · {report.deployment.accessGate ? t("runtime.enabled") : t("runtime.disabled")}</span>
          <span data-ready={report.deployment.independentSessionSecret}><strong>{report.deployment.independentSessionSecret ? t("runtime.ready") : t("runtime.needsAttention")}</strong>{t("runtime.sessionSecret")} · {report.deployment.independentSessionSecret ? t("runtime.configured") : t("runtime.missing")}</span>
          <span data-ready={report.deployment.nodeEnv === "production"}><strong>{report.deployment.nodeEnv === "production" ? t("runtime.ready") : t("runtime.needsAttention")}</strong>{report.deployment.nodeEnv} {t("runtime.mode")}</span>
        </div>
        <ul>{report.deployment.warnings.map((warning) => <li key={warning}>{warningLabel(warning)}</li>)}</ul>
      </section>
      <section className={styles.commands}>
        <div><span>{t("runtime.updateGlobal")}</span><code>{report.commands.updateGlobal}</code><button type="button" onClick={() => copy(report.commands.updateGlobal)}>{t("runtime.copy")}</button></div>
        <div><span>{t("runtime.updateProject")}</span><code>{report.commands.updateProject}</code><button type="button" onClick={() => copy(report.commands.updateProject)}>{t("runtime.copy")}</button></div>
      </section>
      <p className={styles.timestamp}>{t("runtime.checked")} · {new Date(report.checkedAt).toLocaleString(locale === "zh" ? "zh-TW" : "en")}</p>
    </div>
  );
}
