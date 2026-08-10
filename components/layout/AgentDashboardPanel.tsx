"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showToast } from "@/hooks/useToast";
import { useI18n } from "@/lib/i18n";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  isAgentRunConcurrency,
  MAX_AGENT_RUN_CONCURRENCY,
  MIN_AGENT_RUN_CONCURRENCY,
  TERMINAL_AGENT_RUN_STATUSES,
  type AgentRun,
  type AgentRunsResponse,
} from "@/lib/agent-run-types";
import { AgentRunCard } from "./AgentRunCard";
import { AgentRunForm } from "./AgentRunForm";
import s from "./AgentDashboardPanel.module.css";

interface Props {
  defaultCwd: string | null;
  onOpenSession: (sessionId: string) => void | Promise<void>;
  onCompareSessions?: (sessionIds: string[]) => void | Promise<void>;
}

type Filter = "all" | "active" | "queued" | "done";

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function AgentDashboardPanel({ defaultCwd, onOpenSession, onCompareSessions }: Props) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  const [editorOpen, setEditorOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [concurrencyOpen, setConcurrencyOpen] = useState(false);
  const concurrencyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!concurrencyOpen) return;
    const closeMenu = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setConcurrencyOpen(false);
        return;
      }
      if (!concurrencyRef.current?.contains(event.target as Node)) {
        setConcurrencyOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, [concurrencyOpen]);

  const load = useCallback(async (quiet = false) => {
    try {
      const response = await fetch("/api/agent-runs?limit=200", { cache: "no-store" });
      const body = await response.json() as Partial<AgentRunsResponse> & { error?: string };
      if (!response.ok || !body.runs) throw new Error(body.error || `HTTP ${response.status}`);
      setRuns(body.runs);
      setMaxConcurrency(body.maxConcurrency ?? 3);
      setError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (!quiet) showToast(t("agents.loadFailed"), { type: "error" });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visibleRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return runs.filter((run) => {
      if (filter === "active" && !ACTIVE_AGENT_RUN_STATUSES.has(run.status)) return false;
      if (filter === "queued" && run.status !== "queued") return false;
      if (filter === "done" && !TERMINAL_AGENT_RUN_STATUSES.has(run.status)) return false;
      if (!normalizedQuery) return true;
      return `${run.name}\n${run.cwd}\n${run.prompt}\n${run.workspace?.branch ?? ""}`
        .toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [filter, query, runs]);

  const groups = useMemo(() => {
    const grouped = new Map<string, AgentRun[]>();
    for (const run of visibleRuns) {
      const root = run.workspace?.repoRoot ?? run.cwd;
      const list = grouped.get(root) ?? [];
      list.push(run);
      grouped.set(root, list);
    }
    return [...grouped.entries()];
  }, [visibleRuns]);

  const act = async (run: AgentRun, action: "cancel" | "retry") => {
    setBusyId(run.id);
    try {
      const response = await fetch(`/api/agent-runs/${encodeURIComponent(run.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load(true);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t("agents.actionFailed"), { type: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const toggleCompare = (run: AgentRun) => {
    if (!run.sessionId) return;
    setCompareIds((current) => {
      if (current.includes(run.id)) return current.filter((id) => id !== run.id);
      if (current.length >= 3) {
        showToast(t("agents.compareLimit"), { type: "warning" });
        return current;
      }
      return [...current, run.id];
    });
  };

  const openComparedSessions = async () => {
    if (!onCompareSessions || compareIds.length < 2) return;
    const sessionIds = compareIds
      .map((id) => runs.find((run) => run.id === id)?.sessionId)
      .filter((id): id is string => Boolean(id));
    if (sessionIds.length < 2) return;
    await onCompareSessions(sessionIds);
    setCompareOpen(false);
  };

  const comparedRuns = compareIds.map((id) => runs.find((run) => run.id === id)).filter((run): run is AgentRun => Boolean(run));

  const updateConcurrency = async (nextValue: number) => {
    if (savingConcurrency || nextValue === maxConcurrency) return;
    setSavingConcurrency(true);
    try {
      const response = await fetch("/api/agent-runs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrency: nextValue }),
      });
      const body = await response.json() as { maxConcurrency?: number; error?: string };
      if (!response.ok || !isAgentRunConcurrency(body.maxConcurrency)) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setMaxConcurrency(body.maxConcurrency);
      showToast(t("agents.concurrencySaved"), { type: "success" });
    } catch (cause) {
      showToast(
        cause instanceof Error ? cause.message : t("agents.concurrencyFailed"),
        { type: "error" },
      );
    } finally {
      setSavingConcurrency(false);
    }
  };

  if (editorOpen) {
    return (
      <AgentRunForm
        defaultCwd={defaultCwd}
        onCancel={() => setEditorOpen(false)}
        onCreated={(run) => {
          setRuns((current) => [run, ...current]);
          setEditorOpen(false);
          showToast(t("agents.started"), { type: "success" });
          void load(true);
        }}
      />
    );
  }

  const activeCount = runs.filter((run) => ACTIVE_AGENT_RUN_STATUSES.has(run.status)).length;
  const queuedCount = runs.filter((run) => run.status === "queued").length;
  const doneCount = runs.filter((run) => TERMINAL_AGENT_RUN_STATUSES.has(run.status)).length;

  return (
    <section className={s.container} aria-label={t("agents.title")} data-testid="agent-dashboard">
      <div className={`${s.header} chrome-mono`}>
        <strong>{t("agents.title")}</strong>
        <span className={`${s.daemonIndicator} ${error ? s.daemonOffline : ""}`}><i /><span>daemon</span></span>
        <button
          className={s.newButton}
          type="button"
          data-testid="agent-new-run"
          onClick={() => setEditorOpen(true)}
          disabled={!defaultCwd}
        >
          <span aria-hidden="true">＋</span>{t("agents.new")}
        </button>
        {onCompareSessions && compareIds.length > 0 && (
          <button
            className={s.compareButton}
            type="button"
            disabled={compareIds.length < 2}
            onClick={() => setCompareOpen(true)}
            title={t("agents.compareHint")}
          >
            {t("agents.compare")} {compareIds.length > 0 ? `(${compareIds.length})` : ""}
          </button>
        )}
      </div>
      {compareOpen && comparedRuns.length >= 2 && (
        <section className={s.compareTray} aria-label={t("agents.compareResults")}>
          <div className={s.compareTrayHeader}>
            <strong>{t("agents.compareResults")}</strong>
            <button type="button" onClick={() => setCompareOpen(false)} aria-label={t("common.close")}>×</button>
          </div>
          <div className={s.compareGrid}>
            {comparedRuns.map((run) => <article key={run.id}>
              <strong>{run.name}</strong>
              <span>{run.report?.summary ?? run.error ?? t("agents.noReport")}</span>
              <dl>
                <div><dt>{t("agents.files")}</dt><dd>{run.report?.changedFiles.length ?? 0}</dd></div>
                <div><dt>{t("agents.tests")}</dt><dd>{run.report?.tests.length ?? 0}</dd></div>
                <div><dt>{t("agents.cost")}</dt><dd>${(run.report?.usage.cost ?? 0).toFixed(3)}</dd></div>
              </dl>
            </article>)}
          </div>
          <button type="button" className={s.compareOpenSessions} onClick={() => void openComparedSessions()}>{t("agents.openComparedSessions")}</button>
        </section>
      )}
      <div className={s.summary} aria-label="Agent run summary">
        <button className={filter === "active" ? s.summaryActive : ""} onClick={() => setFilter(filter === "active" ? "all" : "active")}>
          <strong>{activeCount}</strong><span>{t("agents.active")}</span>
        </button>
        <button className={filter === "queued" ? s.summaryActive : ""} onClick={() => setFilter(filter === "queued" ? "all" : "queued")}>
          <strong>{queuedCount}</strong><span>{t("agents.queued")}</span>
        </button>
        <button className={filter === "done" ? s.summaryActive : ""} onClick={() => setFilter(filter === "done" ? "all" : "done")}>
          <strong>{doneCount}</strong><span>{t("agents.done")}</span>
        </button>
        <div className={s.concurrencyControl} ref={concurrencyRef}>
          <button
            type="button"
            className={s.concurrencyTrigger}
            aria-label={t("agents.concurrencyLabel")}
            aria-haspopup="listbox"
            aria-expanded={concurrencyOpen}
            disabled={savingConcurrency}
            onClick={() => setConcurrencyOpen((open) => !open)}
          >
            <strong>{maxConcurrency}</strong>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
          </button>
          <span>{t("agents.concurrency")}</span>
          {concurrencyOpen && (
            <div className={s.concurrencyMenu} role="listbox" aria-label={t("agents.concurrencyLabel")}>
              {Array.from(
                { length: MAX_AGENT_RUN_CONCURRENCY - MIN_AGENT_RUN_CONCURRENCY + 1 },
                (_, index) => MIN_AGENT_RUN_CONCURRENCY + index,
              ).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={value === maxConcurrency}
                  className={value === maxConcurrency ? s.concurrencyOptionActive : undefined}
                  onClick={() => {
                    setConcurrencyOpen(false);
                    void updateConcurrency(value);
                  }}
                >
                  {value}
                  {value === maxConcurrency && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className={s.filterBar}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("agents.search")} aria-label={t("agents.search")} />
        {(query || filter !== "all") && <button type="button" onClick={() => { setQuery(""); setFilter("all"); }} aria-label="Clear filters">×</button>}
      </div>
      <div className={s.body}>
        {error && <div className={s.listError} role="alert">{error}</div>}
        {loading ? (
          <div className={s.skeleton} aria-busy="true"><span /><span /><span /></div>
        ) : groups.length === 0 ? (
          <div className={s.empty}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6M9 13h4"/><path d="M8 2v2M16 2v2M8 20v2M16 20v2"/></svg>
            <strong>{t("agents.empty")}</strong>
            <span>{t("agents.emptyHint")}</span>
            {defaultCwd && <button className={s.primaryButton} type="button" onClick={() => setEditorOpen(true)}>{t("agents.new")}</button>}
          </div>
        ) : (
          <div className={s.groups}>
            {groups.map(([root, projectRuns]) => (
              <section className={s.group} key={root}>
                <div className={s.groupHeader}>
                  <strong>{projectName(root)}</strong>
                  <span className="chrome-mono">{projectRuns.length}</span>
                </div>
                <div className={s.groupPath} title={root}>{root}</div>
                <div className={s.runList}>
                  {projectRuns.map((run) => (
                    <AgentRunCard
                      key={run.id}
                      run={run}
                      busy={busyId === run.id}
                      selected={compareIds.includes(run.id)}
                      onToggleSelect={onCompareSessions ? toggleCompare : undefined}
                      onCancel={(item) => void act(item, "cancel")}
                      onRetry={(item) => void act(item, "retry")}
                      onOpenSession={onOpenSession}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
