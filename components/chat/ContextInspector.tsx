"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContextReport, ContextResourceEntry, ContextSourceEntry } from "@/lib/context-report";
import { useI18n } from "@/lib/i18n";
import styles from "./ContextInspector.module.css";

type View = "overview" | "instructions" | "skills" | "tools";

function ResourceList({ entries, empty }: { entries: ContextResourceEntry[]; empty: string }) {
  if (entries.length === 0) return <div className={styles.empty}>{empty}</div>;
  return <div className={styles.resourceList}>{entries.map((entry) => (
    <article key={`${entry.path ?? "resource"}:${entry.name}`} className={styles.resource}>
      <span className={styles.resourceDot} data-enabled={entry.enabled !== false} />
      <div>
        <strong>{entry.name}</strong>
        {entry.description && <p>{entry.description}</p>}
        <div className={styles.resourceMeta}>
          {entry.scope && <span>{entry.scope}</span>}
          {entry.source && <span>{entry.source}</span>}
          {entry.path && <code title={entry.path}>{entry.path}</code>}
        </div>
      </div>
    </article>
  ))}</div>;
}

function SourceList({ entries, effectivePrompt }: { entries: ContextSourceEntry[]; effectivePrompt: string }) {
  const { t } = useI18n();
  return <div className={styles.sourceList}>
    <details className={styles.source} open={entries.length === 0}>
      <summary>
        <span>{t("context.effectivePrompt")}</span>
        <small>{effectivePrompt.length.toLocaleString()} {t("context.characters")}</small>
      </summary>
      <pre>{effectivePrompt || t("system.empty")}</pre>
    </details>
    {entries.map((entry) => (
      <details key={`${entry.kind}:${entry.path}`} className={styles.source}>
        <summary>
          <span><em>{entry.kind}</em><code title={entry.path}>{entry.path}</code></span>
          <small>{entry.lines} {t("context.lines")} · {entry.characters.toLocaleString()} {t("context.characters")}</small>
        </summary>
        <pre>{entry.content}</pre>
      </details>
    ))}
  </div>;
}

export function ContextInspector({ sessionId, fallbackPrompt }: { sessionId: string | null; fallbackPrompt: string | null }) {
  const { t } = useI18n();
  const [report, setReport] = useState<ContextReport | null>(null);
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/context-report`, { cache: "no-store" });
      const data = await response.json() as ContextReport & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setReport(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const visiblePrompt = report?.effectiveSystemPrompt ?? fallbackPrompt ?? "";
  const counts = useMemo(() => ({
    instructions: report?.sources.length ?? 0,
    skills: report?.skills.length ?? 0,
    tools: report?.tools.filter((tool) => tool.enabled).length ?? 0,
  }), [report]);

  return (
    <div className={styles.root} data-testid="context-inspector">
      <nav className={styles.tabs} role="tablist" aria-label={t("context.title")}>
        {(["overview", "instructions", "skills", "tools"] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={view === item}
            className={view === item ? styles.tabActive : styles.tab} onClick={() => setView(item)}>
            {t(`context.${item}`)}
            {item !== "overview" && <span>{counts[item]}</span>}
          </button>
        ))}
        <button type="button" className={styles.refresh} onClick={() => void load()} disabled={loading} aria-label={t("context.refresh")}>↻</button>
      </nav>

      <div className={styles.content}>
        {loading && !report ? <div className={styles.empty}>{t("common.loading")}</div> : error && !report ? (
          <div className={styles.error}>{error}</div>
        ) : view === "overview" ? (
          <div className={styles.overview}>
            <div className={styles.metricGrid}>
              <div><strong>{report?.contextUsage?.percent != null ? `${Math.round(report.contextUsage.percent)}%` : "—"}</strong><span>{t("context.usage")}</span></div>
              <div><strong>{report?.contextUsage?.tokens?.toLocaleString() ?? "—"}</strong><span>{t("context.tokens")}</span></div>
              <div><strong>{report?.skills.filter((skill) => skill.enabled).length ?? 0}</strong><span>{t("context.skills")}</span></div>
              <div><strong>{counts.tools}</strong><span>{t("context.activeTools")}</span></div>
            </div>
            <dl className={styles.facts}>
              <div><dt>{t("context.model")}</dt><dd>{report?.model ? `${report.model.provider} / ${report.model.id}` : "—"}</dd></div>
              <div><dt>{t("context.workspace")}</dt><dd title={report?.cwd}>{report?.cwd ?? "—"}</dd></div>
              <div><dt>{t("context.projectTrust")}</dt><dd>{report?.projectTrusted ? t("context.trusted") : t("context.notTrusted")}</dd></div>
              <div><dt>{t("context.window")}</dt><dd>{report?.contextUsage?.contextWindow.toLocaleString() ?? "—"}</dd></div>
            </dl>
            {report?.diagnostics.length ? <div className={styles.diagnostics}>{report.diagnostics.map((diagnostic, index) => (
              <div key={`${diagnostic.message}:${index}`}><strong>{diagnostic.type}</strong><span>{diagnostic.message}</span></div>
            ))}</div> : null}
          </div>
        ) : view === "instructions" ? (
          <SourceList entries={report?.sources ?? []} effectivePrompt={visiblePrompt} />
        ) : view === "skills" ? (
          <>
            <ResourceList entries={report?.skills ?? []} empty={t("context.noSkills")} />
            {!!report?.prompts.length && <><h3 className={styles.subheading}>{t("context.prompts")}</h3><ResourceList entries={report.prompts} empty="" /></>}
          </>
        ) : (
          <ResourceList entries={report?.tools ?? []} empty={t("context.noTools")} />
        )}
      </div>
    </div>
  );
}
