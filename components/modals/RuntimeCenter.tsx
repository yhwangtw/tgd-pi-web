"use client";

import { useCallback, useEffect, useState } from "react";
import { showToast } from "@/hooks/useToast";
import styles from "./RuntimeCenter.module.css";

interface RuntimeReport {
  checkedAt: string;
  web: { version: string };
  embeddedPi: { package: string; version: string; current: boolean | null };
  globalCli: { available: boolean; version?: string; current: boolean | null; error?: string };
  latest: { version?: string; releaseUrl: string; error?: string };
  commands: { updateGlobal: string; updateProject: string };
}

function StateBadge({ current, unavailable = false }: { current: boolean | null; unavailable?: boolean }) {
  const state = unavailable ? "unavailable" : current === null ? "unknown" : current ? "current" : "update";
  const label = unavailable ? "Unavailable" : current === null ? "Unknown" : current ? "Current" : "Update available";
  return <span className={styles.badge} data-state={state}>{label}</span>;
}

export function RuntimeCenter() {
  const [report, setReport] = useState<RuntimeReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/runtime/status", { cache: "no-store" });
      const body = await response.json() as RuntimeReport & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setReport(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => showToast("Command copied", { type: "success" }));
  };

  if (loading) return <div className={styles.state}>Checking runtime versions…</div>;
  if (error) return <div className={styles.state} data-error>{error}<button type="button" onClick={() => void load()}>Retry</button></div>;
  if (!report) return null;

  return (
    <div className={styles.root}>
      <div className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>Runtime health</div>
          <h2>Pi versions in one place</h2>
          <p>Pi Web embeds its own runtime. The global CLI is shown separately so an older local CLI never looks like a broken web deployment.</p>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void load()}>Refresh</button>
      </div>
      <div className={styles.grid}>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>Pi Web</span><StateBadge current /></div>
          <strong>{report.web.version}</strong>
          <small>Version deployed by this application</small>
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>Embedded Pi runtime</span><StateBadge current={report.embeddedPi.current} /></div>
          <strong>{report.embeddedPi.version}</strong>
          <small>{report.embeddedPi.package}</small>
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>Global Pi CLI</span><StateBadge current={report.globalCli.current} unavailable={!report.globalCli.available} /></div>
          <strong>{report.globalCli.version ?? "Not detected"}</strong>
          <small>Only affects commands run directly in your terminal</small>
        </article>
        <article className={styles.card}>
          <div className={styles.cardHeader}><span>Latest stable</span><StateBadge current={report.latest.version ? true : null} /></div>
          <strong>{report.latest.version ?? "Offline"}</strong>
          <a href={report.latest.releaseUrl} target="_blank" rel="noreferrer">Official Pi releases ↗</a>
        </article>
      </div>
      <section className={styles.commands}>
        <div><span>Update the global CLI</span><code>{report.commands.updateGlobal}</code><button type="button" onClick={() => copy(report.commands.updateGlobal)}>Copy</button></div>
        <div><span>Update this project</span><code>{report.commands.updateProject}</code><button type="button" onClick={() => copy(report.commands.updateProject)}>Copy</button></div>
      </section>
      <p className={styles.timestamp}>Checked {new Date(report.checkedAt).toLocaleString()}</p>
    </div>
  );
}
