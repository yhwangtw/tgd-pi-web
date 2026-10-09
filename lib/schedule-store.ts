import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ACTIVE_SCHEDULE_RUN_STATUSES, type AgentSchedule, type ScheduleExecution, type ScheduleRun, type ScheduleStore } from "./schedule-types";

const MAX_RUNS = 500;
const RUN_STATUSES = new Set(["running", "waiting_for_input", "completed", "failed", "skipped"]);
const RUN_TRIGGERS = new Set(["scheduled", "manual"]);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isExecution(value: unknown): value is ScheduleExecution {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ScheduleExecution>;
  return typeof item.cwd === "string" && typeof item.prompt === "string"
    && Array.isArray(item.toolNames) && item.toolNames.every(tool => typeof tool === "string")
    && isOptionalString(item.provider) && isOptionalString(item.modelId)
    && (!!item.provider === !!item.modelId) && isOptionalString(item.thinkingLevel);
}

function isTiming(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const timing = value as Record<string, unknown>;
  if (timing.kind === "once") return typeof timing.date === "string" && typeof timing.time === "string";
  if (timing.kind === "daily") return typeof timing.time === "string";
  if (timing.kind === "weekly") {
    return typeof timing.time === "string" && Array.isArray(timing.weekdays)
      && timing.weekdays.every((day) => typeof day === "number");
  }
  return timing.kind === "cron" && typeof timing.expression === "string";
}

export function scheduleStorePath(): string {
  return join(getAgentDir(), "schedules.json");
}

function emptyStore(): ScheduleStore {
  return { version: 1, schedules: [], runs: [] };
}

function isSchedule(value: unknown): value is AgentSchedule {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentSchedule>;
  return typeof item.id === "string" && typeof item.name === "string"
    && typeof item.cwd === "string" && typeof item.prompt === "string"
    && (item.engine === undefined || item.engine === "durable")
    && isTiming(item.timing)
    && typeof item.timezone === "string" && typeof item.enabled === "boolean"
    && (item.missedRunPolicy === "run_once" || item.missedRunPolicy === "skip")
    && Array.isArray(item.toolNames) && item.toolNames.every((tool) => typeof tool === "string")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string"
    && (item.nextRunAt === null || typeof item.nextRunAt === "string")
    && isOptionalString(item.provider) && isOptionalString(item.modelId)
    && (!!item.provider === !!item.modelId)
    && isOptionalString(item.thinkingLevel) && isOptionalString(item.lastRunAt)
    && (item.lastRunStatus === undefined || RUN_STATUSES.has(item.lastRunStatus));
}

function isRun(value: unknown): value is ScheduleRun {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ScheduleRun>;
  return typeof item.id === "string" && typeof item.scheduleId === "string"
    && typeof item.scheduleName === "string" && typeof item.startedAt === "string"
    && typeof item.scheduledFor === "string" && RUN_STATUSES.has(item.status ?? "")
    && RUN_TRIGGERS.has(item.trigger ?? "") && isOptionalString(item.finishedAt)
    && isOptionalString(item.sessionId) && isOptionalString(item.error)
    && (item.engine === undefined || item.engine === "durable")
    && (item.execution === undefined || isExecution(item.execution));
}

export function readScheduleStore(path = scheduleStorePath()): ScheduleStore {
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ScheduleStore>;
    return {
      version: 1,
      schedules: Array.isArray(raw.schedules) ? raw.schedules.filter(isSchedule) : [],
      runs: Array.isArray(raw.runs) ? raw.runs.filter(isRun).slice(0, MAX_RUNS) : [],
    };
  } catch {
    return emptyStore();
  }
}

export function writeScheduleStore(store: ScheduleStore, path = scheduleStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized: ScheduleStore = {
    version: 1,
    schedules: store.schedules,
    runs: store.runs.slice(0, MAX_RUNS),
  };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function mutateScheduleStore<T>(
  mutate: (store: ScheduleStore) => T,
  path = scheduleStorePath(),
): T {
  const store = readScheduleStore(path);
  const result = mutate(store);
  writeScheduleStore(store, path);
  return result;
}

export function reconcileInterruptedRuns(path = scheduleStorePath(), now = new Date()): number {
  const store = readScheduleStore(path);
  let changed = 0;
  for (const run of store.runs) {
    if (!ACTIVE_SCHEDULE_RUN_STATUSES.has(run.status)) continue;
    if (run.engine === "durable") continue;
    run.status = "failed";
    run.finishedAt = now.toISOString();
    run.error = "The server restarted before this run completed";
    const schedule = store.schedules.find((item) => item.id === run.scheduleId);
    if (schedule) schedule.lastRunStatus = "failed";
    changed++;
  }
  if (changed > 0) writeScheduleStore(store, path);
  return changed;
}
