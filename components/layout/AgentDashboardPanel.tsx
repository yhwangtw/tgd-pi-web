"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useEffect, useMemo, useState } from "react";
import { Bot, Search, X } from "lucide-react";
import { fetchJson, useRequestResource } from "@/hooks/useRequestResource";
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
import { setRequestData } from "@/lib/request-state";
import { AgentRunCard } from "./AgentRunCard";
import { AgentBudgetSettings } from "./AgentBudgetSettings";
import { AgentRunForm } from "./AgentRunForm";
import s from "./AgentDashboardPanel.module.css";

interface Props {
  defaultCwd: string | null;
  onOpenSession: (sessionId: string) => void | Promise<void>;
  onCompareSessions?: (sessionIds: string[]) => void | Promise<void>;
}

type Filter = "all" | "active" | "queued" | "done";
const EMPTY_AGENT_RUNS: AgentRun[] = [];

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function AgentDashboardPanel({ defaultCwd, onOpenSession, onCompareSessions }: Props) {
  const { t, locale } = useI18n();
  const [editorOpen, setEditorOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const agentRuns = useRequestResource<AgentRunsResponse>(
    "agent-runs:200",
    async (signal) => {
      const body = await fetchJson<Partial<AgentRunsResponse>>(
        "/api/agent-runs?limit=200",
        { cache: "no-store" },
        signal,
      );
      if (!body.runs) throw new Error("Agent run response is missing runs");
      return { ...body, runs: body.runs } as AgentRunsResponse;
    },
    { staleTimeMs: 1_000, retries: 1 },
  );
  const runs = agentRuns.data?.runs ?? EMPTY_AGENT_RUNS;
  const maxConcurrency = agentRuns.data?.maxConcurrency ?? 3;
  const refreshRuns = agentRuns.refresh;
  const error = agentRuns.error;
  const hasFilters = Boolean(query.trim()) || filter !== "all";
  const clearFilters = () => { setQuery(""); setFilter("all"); };

  useEffect(() => {
    const timer = window.setInterval(() => void refreshRuns(), 2_000);
    return () => window.clearInterval(timer);
  }, [refreshRuns]);

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

  const act = async (run: AgentRun, action: "cancel" | "retry" | "extend") => {
    setBusyId(run.id);
    try {
      const response = await fetch(`/api/agent-runs/${encodeURIComponent(run.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await refreshRuns();
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
      if (agentRuns.data) {
        setRequestData("agent-runs:200", { ...agentRuns.data, maxConcurrency: body.maxConcurrency });
      } else {
        await refreshRuns();
      }
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

  const activeCount = runs.filter((run) => ACTIVE_AGENT_RUN_STATUSES.has(run.status)).length;
  const queuedCount = runs.filter((run) => run.status === "queued").length;
  const doneCount = runs.filter((run) => TERMINAL_AGENT_RUN_STATUSES.has(run.status)).length;

  return (
    <section className={s.container} aria-label={t("agents.title")} data-testid="agent-dashboard">
      {editorOpen && (
        <AgentRunForm
          defaultCwd={defaultCwd}
          onCancel={() => setEditorOpen(false)}
          onCreated={() => {
            setEditorOpen(false);
            showToast(t("agents.started"), { type: "success" });
            void refreshRuns();
          }}
        />
      )}
      <div className={s.header}>
        <strong>{t("agents.title")}</strong>
        <span className={`${s.daemonIndicator} ${error ? s.daemonOffline : ""}`}><i /><span>{t("agents.backgroundService")}</span></span>
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
      {agentRuns.data?.upstreamStatus && (
        <p className={s.path} data-testid="upstream-run-scope">{t("agents.upstream.scope")}</p>
      )}
      {agentRuns.data?.upstreamStatus?.delegationBlockedBySavedLimits && (
        <p className={s.runError} role="status" data-testid="upstream-run-limits-blocked">{t("agents.upstream.savedLimitsBlocked")}</p>
      )}
      {agentRuns.data?.upstreamStatus?.partial && (
        <p className={s.runError} role="status" data-testid="upstream-run-partial">{t("agents.upstream.incomplete")}</p>
      )}
      {compareOpen && comparedRuns.length >= 2 && (
        <section className={s.compareTray} aria-label={t("agents.compareResults")}>
          <div className={s.compareTrayHeader}>
            <strong>{t("agents.compareResults")}</strong>
            <button type="button" onClick={() => setCompareOpen(false)} aria-label={t("common.close")}><X size={UI_ICON_SIZE.control} aria-hidden="true" /></button>
          </div>
          <div className={s.compareGrid}>
            {comparedRuns.map((run) => <article key={run.id}>
              <strong>{run.name}</strong>
              <time dateTime={run.startedAt ?? run.createdAt}>{new Date(run.startedAt ?? run.createdAt).toLocaleString(locale === "zh" ? "zh-TW" : "en")}</time>
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
      <div className={s.summary} aria-label={t("agents.runSummary")}>
        <button type="button" aria-pressed={filter === "active"} className={filter === "active" ? s.summaryActive : ""} onClick={() => setFilter(filter === "active" ? "all" : "active")}>
          <strong>{activeCount}</strong><span>{t("agents.active")}</span>
        </button>
        <button type="button" aria-pressed={filter === "queued"} className={filter === "queued" ? s.summaryActive : ""} onClick={() => setFilter(filter === "queued" ? "all" : "queued")}>
          <strong>{queuedCount}</strong><span>{t("agents.queued")}</span>
        </button>
        <button type="button" aria-pressed={filter === "done"} className={filter === "done" ? s.summaryActive : ""} onClick={() => setFilter(filter === "done" ? "all" : "done")}>
          <strong>{doneCount}</strong><span>{t("agents.done")}</span>
        </button>
        <label className={s.concurrencyControl}>
          <span>{t("agents.concurrency")}</span>
          <select
            aria-label={t("agents.concurrencyLabel")}
            value={maxConcurrency}
            disabled={savingConcurrency}
            onChange={(event) => void updateConcurrency(Number(event.target.value))}
          >
            {Array.from(
              { length: MAX_AGENT_RUN_CONCURRENCY - MIN_AGENT_RUN_CONCURRENCY + 1 },
              (_, index) => MIN_AGENT_RUN_CONCURRENCY + index,
            ).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      {agentRuns.data && <AgentBudgetSettings limits={agentRuns.data.subagentLimits} maxConcurrency={maxConcurrency} onSaved={() => void refreshRuns()} />}
      <div className={s.filterBar}>
        <Search size={UI_ICON_SIZE.compact} aria-hidden="true" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("agents.search")} aria-label={t("agents.search")} />
        {(query || filter !== "all") && <button type="button" onClick={clearFilters} aria-label={t("agents.clearFilters")}><X size={UI_ICON_SIZE.control} aria-hidden="true" /></button>}
      </div>
      <div className={s.body}>
        {error && <div className={s.listError} role="alert"><span>{error}</span><button type="button" onClick={() => void refreshRuns()}>{t("common.retry")}</button></div>}
        {agentRuns.loading ? (
          <div className={s.skeleton} aria-busy="true"><span /><span /><span /></div>
        ) : groups.length === 0 ? (
          <div className={s.empty}>
            <Bot size={30} aria-hidden />
            <strong>{t(hasFilters ? "agents.noMatches" : "agents.empty")}</strong>
            <span>{t(hasFilters ? "agents.noMatchesHint" : "agents.emptyHint")}</span>
            {hasFilters ? (
              <button className={s.primaryButton} type="button" onClick={clearFilters}>{t("agents.clearFilters")}</button>
            ) : defaultCwd && <button className={s.primaryButton} type="button" onClick={() => setEditorOpen(true)}>{t("agents.new")}</button>}
          </div>
        ) : (
          <div className={s.groups}>
            {groups.map(([root, projectRuns]) => (
              <section className={s.group} key={root}>
                <div className={s.groupHeader}>
                  <strong>{projectName(root)}</strong>
                  <span>{projectRuns.length}</span>
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
                      onExtend={(item) => void act(item, "extend")}
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
