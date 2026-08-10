"use client";

import { useState } from "react";
import { useI18n, type MsgKey } from "@/lib/i18n";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  TERMINAL_AGENT_RUN_STATUSES,
  type AgentRun,
} from "@/lib/agent-run-types";
import s from "./AgentDashboardPanel.module.css";

const STATUS_KEYS: Record<AgentRun["status"], MsgKey> = {
  queued: "agents.status.queued",
  running: "agents.status.running",
  waiting_for_input: "agents.status.waiting_for_input",
  completed: "agents.status.completed",
  failed: "agents.status.failed",
  cancelled: "agents.status.cancelled",
  interrupted: "agents.status.interrupted",
};

interface Props {
  run: AgentRun;
  busy: boolean;
  selected?: boolean;
  onToggleSelect?: (run: AgentRun) => void;
  onCancel: (run: AgentRun) => void;
  onRetry: (run: AgentRun) => void;
  onOpenSession: (sessionId: string) => void | Promise<void>;
}

export function AgentRunCard({ run, busy, selected = false, onToggleSelect, onCancel, onRetry, onOpenSession }: Props) {
  const { locale, t } = useI18n();
  const [reportOpen, setReportOpen] = useState(false);
  const active = run.status === "queued" || ACTIVE_AGENT_RUN_STATUSES.has(run.status);
  const terminal = TERMINAL_AGENT_RUN_STATUSES.has(run.status);
  const time = new Intl.DateTimeFormat(locale === "zh" ? "zh-TW" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(run.startedAt ?? run.createdAt));

  return (
    <article className={`${s.card} ${run.status === "waiting_for_input" ? s.cardWaiting : ""}`} data-testid="agent-run-card">
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
        {run.workspace?.branch && <span className={`${s.branch} chrome-mono`}>{run.workspace.branch}</span>}
      </div>
      <div className={s.cardMeta}>
        <span className={`${s.statusBadge} ${s[`status_${run.status}`]}`}>{t(STATUS_KEYS[run.status])}</span>
        <time dateTime={run.startedAt ?? run.createdAt}>{time}</time>
      </div>
      <p className={s.promptPreview}>{run.prompt}</p>
      <div className={`${s.path} chrome-mono`} title={run.cwd}>{run.cwd}</div>
      {run.error && <div className={s.runError} role="status">{run.error}</div>}
      {run.report && (
        <div className={s.runReport}>
          <button type="button" className={s.reportToggle} aria-expanded={reportOpen} onClick={() => setReportOpen((open) => !open)}>
            <span>{t("agents.report")}</span>
            <span className="chrome-mono">
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
      <div className={s.cardActions}>
        {run.sessionId && (
          <button type="button" onClick={() => void onOpenSession(run.sessionId as string)}>
            {t("agents.openSession")}
          </button>
        )}
        {active && (
          <button type="button" disabled={busy} onClick={() => onCancel(run)} className={s.dangerTextButton}>
            {t("agents.cancel")}
          </button>
        )}
        {terminal && (
          <button type="button" disabled={busy} onClick={() => onRetry(run)}>
            {t("agents.retry")}
          </button>
        )}
      </div>
    </article>
  );
}
