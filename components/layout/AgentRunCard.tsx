"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useI18n, type MsgKey } from "@/lib/i18n";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  TERMINAL_AGENT_RUN_STATUSES,
  type AgentRun,
} from "@/lib/agent-run-types";
import s from "./AgentDashboardPanel.module.css";

const AgentRunTranscript = dynamic(() => import("./AgentRunTranscript").then(module => module.AgentRunTranscript));

const STATUS_KEYS: Record<AgentRun["status"], MsgKey> = {
  queued: "agents.status.queued",
  running: "agents.status.running",
  waiting_for_input: "agents.status.waiting_for_input",
  completed: "agents.status.completed",
  failed: "agents.status.failed",
  cancelled: "agents.status.cancelled",
  interrupted: "agents.status.interrupted",
};

const UPSTREAM_STATUS_KEYS: Record<NonNullable<AgentRun["upstream"]>["state"], MsgKey> = {
  queued: "agents.status.queued", running: "agents.status.running", complete: "agents.status.completed",
  failed: "agents.status.failed", partial: "agents.upstream.partialRun", paused: "agents.upstream.paused",
  stopped: "agents.status.cancelled", rejected: "agents.upstream.rejected",
};

interface Props {
  run: AgentRun;
  busy: boolean;
  selected?: boolean;
  onToggleSelect?: (run: AgentRun) => void;
  onCancel: (run: AgentRun) => void;
  onRetry: (run: AgentRun) => void;
  onExtend?: (run: AgentRun) => void;
  onOpenSession: (sessionId: string) => void | Promise<void>;
}

export function AgentRunCard({ run, busy, selected = false, onToggleSelect, onCancel, onRetry, onExtend, onOpenSession }: Props) {
  const { locale, t } = useI18n();
  const [reportOpen, setReportOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const active = run.status === "queued" || ACTIVE_AGENT_RUN_STATUSES.has(run.status);
  const terminal = TERMINAL_AGENT_RUN_STATUSES.has(run.status);
  const upstream = run.engine === "upstream";
  const canCancel = upstream ? run.upstream?.canStop === true : active;
  const canRetry = terminal && (!upstream || run.upstream?.canRetry === true);
  const statusKey = upstream && run.upstream ? UPSTREAM_STATUS_KEYS[run.upstream.state] : STATUS_KEYS[run.status];
  const repair = run.status === "failed" || run.status === "interrupted";
  const time = new Intl.DateTimeFormat(locale === "zh" ? "zh-TW" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(run.startedAt ?? run.createdAt));

  return (
    <article className={`${s.card} ${run.status === "waiting_for_input" ? s.cardWaiting : ""}`} data-status={run.status} data-testid="agent-run-card">
      {transcriptOpen && <AgentRunTranscript run={run} onClose={() => setTranscriptOpen(false)} />}
      <div className={s.cardHeader}>
        {run.sessionId && onToggleSelect && (
          <input
            className={s.compareCheck}
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(run)}
            aria-label={`${t("agents.selectForCompare")}: ${run.name}`}
          />
        )}
        <span className={`${s.statusDot} ${s[`status_${run.status}`]}`} aria-hidden="true" />
        <strong className={s.cardTitle}>{run.name}</strong>
        {upstream && <span className={s.subagentBadge}>{t("agents.upstream.badge")}</span>}
        {!upstream && run.trigger === "subagent" && <span className={s.subagentBadge}>{t("agents.subagent")}</span>}
        {run.workspace?.branch && <span className={`${s.branch} chrome-mono`}>{run.workspace.branch}</span>}
      </div>
      <div className={s.cardMeta}>
        <span className={`${s.statusBadge} ${s[`status_${run.status}`]}`}>{t(statusKey)}</span>
        <time dateTime={run.startedAt ?? run.createdAt}>{time}</time>
      </div>
      <div className={s.cardDetails}>
        <p className={s.promptPreview}>{upstream ? t("agents.upstream.description") : run.prompt}</p>
        {run.upstream?.statusStale && <p role="status">{t("agents.upstream.stale")}</p>}
        {run.upstream?.stopRequested && <p role="status">{t("agents.upstream.stopping")}</p>}
        <details className={s.runDetails}>
          <summary>{t("ui.technicalDetails")}</summary>
          {upstream && <span>{t("agents.upstream.parentWorkspace")}</span>}
          <div className={`${s.path} chrome-mono`}>{run.cwd}</div>
          {run.error && <div className={s.runError}>{run.error}</div>}
        </details>
        {active && run.limitWarning && <p role="status">{t("agents.limitNear")}</p>}
        {run.progress && !run.report && <p>{t("agents.turns")}: {run.progress.turns} · {new Intl.NumberFormat(locale === "zh" ? "zh-TW" : "en", { style: "currency", currency: "USD" }).format(run.progress.costUsd)}</p>}
        {run.report && (
          <div className={s.runReport}>
            <button type="button" className={s.reportToggle} aria-expanded={reportOpen} onClick={() => setReportOpen((open) => !open)}>
              <span>{t("agents.report")}</span>
              <span>
                {run.report.changedFiles.length} {t("agents.files")} · {run.report.tests.length} {t("agents.tests")} · ${run.report.usage.cost.toFixed(3)}
              </span>
            </button>
            {reportOpen && <div className={s.reportBody}>
              <p>{run.report.summary}</p>
              {run.report.changedFiles.length > 0 && <div><strong>{t("agents.changedFiles")}</strong><ul>{run.report.changedFiles.map((file) => <li key={file} className="chrome-mono">{file}</li>)}</ul></div>}
              {run.report.tests.length > 0 && <div><strong>{t("agents.tests")}</strong><ul>{run.report.tests.map((test, index) => <li key={`${test.name}-${index}`}><span className={s[`test_${test.status}`]}>{test.status}</span> {test.name}</li>)}</ul></div>}
            </div>}
          </div>
        )}
      </div>
      <div className={s.cardActions}>
        {!upstream && <button type="button" onClick={() => setTranscriptOpen(true)}>{t("agents.openTranscript")}</button>}
        {!upstream && ACTIVE_AGENT_RUN_STATUSES.has(run.status) && onExtend && <button type="button" disabled={busy} onClick={() => onExtend(run)}>{t("agents.extend")}</button>}
        {upstream && run.parentSessionId && (
          <button type="button" onClick={() => void onOpenSession(run.parentSessionId as string)}>{t("agents.upstream.openParent")}</button>
        )}
        {run.sessionId && (
          <button type="button" onClick={() => void onOpenSession(run.sessionId as string)}>
            {t("agents.openSession")}
          </button>
        )}
        {canCancel && (
          <button type="button" disabled={busy} onClick={() => onCancel(run)} className={s.dangerTextButton}>
            {t("agents.cancel")}
          </button>
        )}
        {canRetry && (
          <button type="button" className={repair ? s.repairButton : undefined} disabled={busy} onClick={() => onRetry(run)}>
            {t("agents.retry")}
          </button>
        )}
      </div>
    </article>
  );
}
