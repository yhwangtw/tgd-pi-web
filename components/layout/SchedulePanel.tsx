"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { showToast } from "@/hooks/useToast";
import { useI18n, type MsgKey } from "@/lib/i18n";
import type {
  AgentSchedule,
  ScheduleKind,
  ScheduleRun,
  ScheduleTiming,
  SchedulesResponse,
} from "@/lib/schedule-types";
import s from "./SchedulePanel.module.css";

interface Props {
  defaultCwd: string | null;
  onOpenSession: (sessionId: string) => void | Promise<void>;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

type ToolMode = "readonly" | "coding" | "none";

interface Draft {
  id?: string;
  name: string;
  cwd: string;
  prompt: string;
  kind: ScheduleKind;
  date: string;
  time: string;
  weekdays: number[];
  cron: string;
  timezone: string;
  model: string;
  thinkingLevel: string;
  toolMode: ToolMode;
  missedRunPolicy: "run_once" | "skip";
  enabled: boolean;
}

const TOOL_NAMES: Record<ToolMode, string[]> = {
  readonly: ["read", "grep", "find", "ls", "ask_user"],
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user"],
  none: [],
};

const STATUS_KEYS: Record<ScheduleRun["status"], MsgKey> = {
  running: "schedule.status.running",
  waiting_for_input: "schedule.status.waiting_for_input",
  completed: "schedule.status.completed",
  failed: "schedule.status.failed",
  skipped: "schedule.status.skipped",
};

const WEEKDAY_KEYS: MsgKey[] = [
  "schedule.sun", "schedule.mon", "schedule.tue", "schedule.wed",
  "schedule.thu", "schedule.fri", "schedule.sat",
];

const COMMON_TIMEZONES = [
  "UTC", "Asia/Taipei", "Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore",
  "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "Australia/Sydney",
];

function defaultDateTime(): { date: string; time: string } {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function emptyDraft(cwd: string | null): Draft {
  const initial = defaultDateTime();
  return {
    name: "",
    cwd: cwd ?? "",
    prompt: "",
    kind: "daily",
    date: initial.date,
    time: initial.time,
    weekdays: [1, 2, 3, 4, 5],
    cron: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    model: "",
    thinkingLevel: "auto",
    toolMode: "readonly",
    missedRunPolicy: "run_once",
    enabled: true,
  };
}

function modelValue(provider?: string, modelId?: string): string {
  return provider && modelId ? JSON.stringify([provider, modelId]) : "";
}

function toolsMode(toolNames: string[]): ToolMode {
  if (toolNames.length === 0) return "none";
  return toolNames.some((name) => name === "edit" || name === "write" || name === "bash")
    ? "coding"
    : "readonly";
}

function scheduleDraft(schedule: AgentSchedule): Draft {
  const once = schedule.timing.kind === "once" ? schedule.timing : null;
  const weekly = schedule.timing.kind === "weekly" ? schedule.timing : null;
  const cron = schedule.timing.kind === "cron" ? schedule.timing : null;
  const clock = "time" in schedule.timing ? schedule.timing.time : "09:00";
  return {
    id: schedule.id,
    name: schedule.name,
    cwd: schedule.cwd,
    prompt: schedule.prompt,
    kind: schedule.timing.kind,
    date: once?.date ?? defaultDateTime().date,
    time: clock,
    weekdays: weekly?.weekdays ?? [1, 2, 3, 4, 5],
    cron: cron?.expression ?? "0 9 * * 1-5",
    timezone: schedule.timezone,
    model: modelValue(schedule.provider, schedule.modelId),
    thinkingLevel: schedule.thinkingLevel ?? "auto",
    toolMode: toolsMode(schedule.toolNames),
    missedRunPolicy: schedule.missedRunPolicy,
    enabled: schedule.enabled,
  };
}

function timingFromDraft(draft: Draft): ScheduleTiming {
  if (draft.kind === "once") return { kind: "once", date: draft.date, time: draft.time };
  if (draft.kind === "daily") return { kind: "daily", time: draft.time };
  if (draft.kind === "weekly") return { kind: "weekly", time: draft.time, weekdays: draft.weekdays };
  return { kind: "cron", expression: draft.cron };
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function scheduleSummary(
  schedule: AgentSchedule,
  weekday: (day: number) => string,
  dailyLabel: string,
): string {
  if (schedule.timing.kind === "once") return `${schedule.timing.date} · ${schedule.timing.time}`;
  if (schedule.timing.kind === "daily") return `${dailyLabel} · ${schedule.timing.time}`;
  if (schedule.timing.kind === "weekly") {
    return `${schedule.timing.weekdays.map(weekday).join(" ")} · ${schedule.timing.time}`;
  }
  return schedule.timing.expression;
}

export function SchedulePanel({ defaultCwd, onOpenSession }: Props) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<SchedulesResponse>({ schedules: [], runs: [], serverTime: "" });
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/schedules", { cache: "no-store" });
      setData(await responseJson<SchedulesResponse>(response));
      setError(null);
    } catch (loadError) {
      if (!silent) showToast(t("schedule.loadFailed"), { type: "error" });
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 4_000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!draft?.cwd.startsWith("/")) {
      setModels([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setModelsLoading(true);
      fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: draft.cwd }),
        signal: controller.signal,
      })
        .then((response) => responseJson<{ modelList?: ModelOption[] }>(response))
        .then((catalog) => setModels(catalog.modelList ?? []))
        .catch((catalogError) => {
          if ((catalogError as Error).name !== "AbortError") setModels([]);
        })
        .finally(() => setModelsLoading(false));
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft?.cwd]);

  const latestRuns = useMemo(() => {
    const result = new Map<string, ScheduleRun>();
    for (const run of data.runs) if (!result.has(run.scheduleId)) result.set(run.scheduleId, run);
    return result;
  }, [data.runs]);
  const scheduleIds = useMemo(
    () => new Set(data.schedules.map((schedule) => schedule.id)),
    [data.schedules],
  );

  const patchSchedule = useCallback(async (schedule: AgentSchedule, patch: Record<string, unknown>) => {
    setBusyId(schedule.id);
    setError(null);
    try {
      const response = await fetch(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await responseJson(response);
      await load(true);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError(message);
      showToast(`${t("schedule.actionFailed")}: ${message}`, { type: "error" });
    } finally {
      setBusyId(null);
    }
  }, [load, t]);

  const runNow = useCallback(async (scheduleId: string) => {
    setBusyId(scheduleId);
    setError(null);
    try {
      const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await responseJson(response);
      showToast(t("schedule.started"), { type: "success" });
      await load(true);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError(message);
      showToast(`${t("schedule.actionFailed")}: ${message}`, { type: "error" });
    } finally {
      setBusyId(null);
    }
  }, [load, t]);

  const remove = useCallback(async (scheduleId: string) => {
    setBusyId(scheduleId);
    try {
      const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await responseJson(response);
      setDeleteId(null);
      showToast(t("schedule.deleted"), { type: "success" });
      await load(true);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError(message);
      showToast(`${t("schedule.actionFailed")}: ${message}`, { type: "error" });
    } finally {
      setBusyId(null);
    }
  }, [load, t]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      let provider: string | undefined;
      let modelId: string | undefined;
      if (draft.model) [provider, modelId] = JSON.parse(draft.model) as [string, string];
      const payload = {
        name: draft.name,
        cwd: draft.cwd,
        prompt: draft.prompt,
        timing: timingFromDraft(draft),
        timezone: draft.timezone,
        provider,
        modelId,
        thinkingLevel: draft.thinkingLevel,
        toolNames: TOOL_NAMES[draft.toolMode],
        missedRunPolicy: draft.missedRunPolicy,
        enabled: draft.enabled,
      };
      const response = await fetch(draft.id ? `/api/schedules/${encodeURIComponent(draft.id)}` : "/api/schedules", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await responseJson(response);
      setDraft(null);
      showToast(t("schedule.saved"), { type: "success" });
      await load(true);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      showToast(`${t("schedule.actionFailed")}: ${message}`, { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const formatRunTime = (value: string, timeZone?: string) => {
    try {
      return new Intl.DateTimeFormat(locale === "zh" ? "zh-TW" : "en", {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timeZone ? { timeZone } : {}),
      }).format(new Date(value));
    } catch {
      return value;
    }
  };

  if (draft) {
    return (
      <div className={s.container} data-testid="schedule-editor">
        <div className={`${s.header} chrome-mono`}>
          <button className={s.iconButton} type="button" onClick={() => { setDraft(null); setError(null); }} title={t("schedule.back")} aria-label={t("schedule.back")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          </button>
          <strong>{draft.id ? t("schedule.edit") : t("schedule.new")}</strong>
        </div>
        <form className={s.form} onSubmit={save}>
          <label className={s.field}>
            <span>{t("schedule.name")}</span>
            <input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("schedule.namePlaceholder")} />
          </label>
          <label className={s.field}>
            <span>{t("schedule.project")}</span>
            <input required value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/path/to/project" className={s.monoInput} />
          </label>
          <label className={s.field}>
            <span>{t("schedule.prompt")}</span>
            <textarea required rows={6} maxLength={200_000} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder={t("schedule.promptPlaceholder")} />
          </label>

          <fieldset className={s.fieldset}>
            <legend>{t("schedule.type")}</legend>
            <div className={s.segmented}>
              {(["once", "daily", "weekly", "cron"] as ScheduleKind[]).map((kind) => (
                <button key={kind} type="button" className={draft.kind === kind ? s.segmentActive : s.segment} onClick={() => setDraft({ ...draft, kind })}>
                  {t(`schedule.${kind}` as MsgKey)}
                </button>
              ))}
            </div>
          </fieldset>

          {draft.kind === "once" && (
            <div className={s.twoColumns}>
              <label className={s.field}><span>{t("schedule.date")}</span><input required type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
              <label className={s.field}><span>{t("schedule.time")}</span><input required type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label>
            </div>
          )}
          {draft.kind === "daily" && (
            <label className={s.field}><span>{t("schedule.time")}</span><input required type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label>
          )}
          {draft.kind === "weekly" && (
            <>
              <label className={s.field}><span>{t("schedule.time")}</span><input required type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label>
              <fieldset className={s.fieldset}>
                <legend>{t("schedule.weekdays")}</legend>
                <div className={s.weekdays}>
                  {WEEKDAY_KEYS.map((key, day) => {
                    const selected = draft.weekdays.includes(day);
                    return <button type="button" key={key} aria-pressed={selected} className={selected ? s.weekdayActive : s.weekday} onClick={() => setDraft({ ...draft, weekdays: selected ? draft.weekdays.filter((item) => item !== day) : [...draft.weekdays, day].sort() })}>{t(key)}</button>;
                  })}
                </div>
              </fieldset>
            </>
          )}
          {draft.kind === "cron" && (
            <label className={s.field}>
              <span>{t("schedule.cronExpression")}</span>
              <input required className={s.monoInput} value={draft.cron} onChange={(event) => setDraft({ ...draft, cron: event.target.value })} placeholder="0 9 * * 1-5" />
              <small>{t("schedule.cronHint")}</small>
            </label>
          )}

          <label className={s.field}>
            <span>{t("schedule.timezone")}</span>
            <input required list="schedule-timezones" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} className={s.monoInput} />
            <datalist id="schedule-timezones">{COMMON_TIMEZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
          </label>

          <details className={s.advanced}>
            <summary>{t("schedule.agentSettings")}</summary>
            <div className={s.advancedBody}>
              <label className={s.field}>
                <span>{t("schedule.model")}</span>
                <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
                  <option value="">{modelsLoading ? t("schedule.modelsLoading") : t("schedule.projectDefault")}</option>
                  {draft.model && !models.some((model) => modelValue(model.provider, model.id) === draft.model) && <option value={draft.model}>{draft.model}</option>}
                  {models.map((model) => <option key={`${model.provider}:${model.id}`} value={modelValue(model.provider, model.id)}>{model.name} · {model.provider}</option>)}
                </select>
              </label>
              <label className={s.field}>
                <span>{t("schedule.thinking")}</span>
                <select value={draft.thinkingLevel} onChange={(event) => setDraft({ ...draft, thinkingLevel: event.target.value })}>
                  {["auto", "off", "minimal", "low", "medium", "high", "xhigh"].map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
              <label className={s.field}>
                <span>{t("schedule.tools")}</span>
                <select value={draft.toolMode} onChange={(event) => setDraft({ ...draft, toolMode: event.target.value as ToolMode })}>
                  <option value="readonly">{t("schedule.toolsReadOnly")}</option>
                  <option value="coding">{t("schedule.toolsCoding")}</option>
                  <option value="none">{t("schedule.toolsNone")}</option>
                </select>
              </label>
              <label className={s.field}>
                <span>{t("schedule.missedRuns")}</span>
                <select value={draft.missedRunPolicy} onChange={(event) => setDraft({ ...draft, missedRunPolicy: event.target.value as Draft["missedRunPolicy"] })}>
                  <option value="run_once">{t("schedule.catchUp")}</option>
                  <option value="skip">{t("schedule.skip")}</option>
                </select>
              </label>
              <label className={s.checkbox}>
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                <span>{t("schedule.enabled")}</span>
              </label>
            </div>
          </details>

          {error && <div className={s.formError} role="alert">{error}</div>}
          <div className={s.formActions}>
            <button type="button" className={s.secondaryButton} onClick={() => setDraft(null)}>{t("schedule.cancel")}</button>
            <button type="submit" className={s.primaryButton} disabled={saving}>{saving ? t("schedule.saving") : t("schedule.save")}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={s.container} data-testid="schedule-panel">
      <div className={`${s.header} chrome-mono`}>
        <strong>{t("schedule.title")}</strong>
        <button className={s.newButton} type="button" onClick={() => { setDraft(emptyDraft(defaultCwd)); setError(null); }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          {t("sidebar.new")}
        </button>
      </div>
      <div className={s.body}>
        {data.health && (
          <div className={s.schedulerHealth} role="status">
            <span className={data.health.state === "healthy" ? s.healthOk : s.healthIdle} aria-hidden />
            <strong>{t("schedule.schedulerHealth")}</strong>
            <span>{data.health.state === "healthy" ? t("schedule.schedulerHealthy") : t("schedule.schedulerIdle")}</span>
            {data.health.nextWakeAt && <time dateTime={data.health.nextWakeAt}>{formatRunTime(data.health.nextWakeAt)}</time>}
          </div>
        )}
        {loading ? (
          <div className={s.empty}>{t("search.searching")}</div>
        ) : data.schedules.length === 0 ? (
          <div className={s.empty}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            <strong>{t("schedule.empty")}</strong>
            <span>{t("schedule.emptyHint")}</span>
            <button type="button" className={s.primaryButton} onClick={() => setDraft(emptyDraft(defaultCwd))}>{t("schedule.new")}</button>
          </div>
        ) : (
          <div className={s.scheduleList}>
            {data.schedules.map((schedule) => {
              const latest = latestRuns.get(schedule.id);
              const waiting = latest?.status === "waiting_for_input";
              return (
                <article key={schedule.id} className={`${s.card} ${waiting ? s.cardWaiting : ""}`}>
                  <div className={s.cardHeader}>
                    <div className={s.cardTitleWrap}>
                      <strong className={s.cardTitle} title={schedule.name}>{schedule.name}</strong>
                      {!schedule.enabled && <span className={s.pausedBadge}>{t("schedule.paused")}</span>}
                    </div>
                    <button className={s.iconButton} type="button" onClick={() => { setDraft(scheduleDraft(schedule)); setError(null); }} title={t("schedule.edit")} aria-label={t("schedule.edit")}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                  </div>
                  <div className={`${s.scheduleLine} chrome-mono`}>{scheduleSummary(schedule, (day) => t(WEEKDAY_KEYS[day]), t("schedule.daily"))}</div>
                  <div className={s.path} title={schedule.cwd}>{schedule.cwd}</div>
                  <div className={s.nextLine}>
                    <span>{schedule.enabled && schedule.nextRunAt ? `${t("schedule.nextRun")} · ${formatRunTime(schedule.nextRunAt, schedule.timezone)}` : t("schedule.paused")}</span>
                    <span className={s.timezone}>{schedule.timezone}</span>
                  </div>
                  {latest && (
                    <div className={`${s.runState} ${s[`status_${latest.status}`]}`}>
                      <span className={s.statusDot} />
                      <span>{t(STATUS_KEYS[latest.status])}</span>
                      {latest.sessionId && <button type="button" onClick={() => void onOpenSession(latest.sessionId as string)}>{t("schedule.openSession")}</button>}
                    </div>
                  )}
                  <div className={s.cardActions}>
                    <button type="button" onClick={() => void runNow(schedule.id)} disabled={busyId === schedule.id || latest?.status === "running" || waiting}>{t("schedule.runNow")}</button>
                    <button type="button" onClick={() => void patchSchedule(schedule, { enabled: !schedule.enabled })} disabled={busyId === schedule.id}>{schedule.enabled ? t("schedule.pause") : t("schedule.resume")}</button>
                    {deleteId === schedule.id ? (
                      <button type="button" className={s.dangerButton} onClick={() => void remove(schedule.id)} disabled={busyId === schedule.id}>{t("schedule.confirmDelete")}</button>
                    ) : (
                      <button type="button" className={s.dangerTextButton} onClick={() => setDeleteId(schedule.id)}>{t("schedule.delete")}</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {error && !draft && <div className={s.listError} role="alert">{error}</div>}

        <details className={s.history} open={data.runs.some((run) => run.status === "waiting_for_input")}>
          <summary>{t("schedule.history")} <span>{data.runs.length}</span></summary>
          <div className={s.historyList}>
            {data.runs.length === 0 ? <div className={s.noHistory}>{t("schedule.noHistory")}</div> : data.runs.slice(0, 30).map((run) => (
              <div className={s.historyRow} key={run.id}>
                <div className={s.historyMain}>
                  <strong title={run.scheduleName}>{run.scheduleName}</strong>
                  <span>{formatRunTime(run.startedAt)}</span>
                </div>
                <div className={s.historyStatus}>
                  <span className={`${s.statusBadge} ${s[`status_${run.status}`]}`}>{t(STATUS_KEYS[run.status])}</span>
                  {run.sessionId && <button type="button" onClick={() => void onOpenSession(run.sessionId as string)}>{t("schedule.openSession")}</button>}
                  {scheduleIds.has(run.scheduleId) && (run.status === "failed" || run.status === "skipped") && <button type="button" onClick={() => void runNow(run.scheduleId)} disabled={busyId === run.scheduleId}>{t("schedule.retry")}</button>}
                </div>
                {run.error && <div className={s.runError}>{run.error}</div>}
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
