export type ScheduleKind = "once" | "daily" | "weekly" | "cron";

export type ScheduleTiming =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] }
  | { kind: "cron"; expression: string };

export type ScheduleMissedRunPolicy = "run_once" | "skip";
export type ScheduleRunStatus =
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "skipped";

export interface AgentSchedule {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  timing: ScheduleTiming;
  timezone: string;
  enabled: boolean;
  missedRunPolicy: ScheduleMissedRunPolicy;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastRunStatus?: ScheduleRunStatus;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  trigger: "scheduled" | "manual";
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: ScheduleRunStatus;
  sessionId?: string;
  error?: string;
}

export interface ScheduleStore {
  version: 1;
  schedules: AgentSchedule[];
  runs: ScheduleRun[];
}

export interface ScheduleInput {
  name: string;
  cwd: string;
  prompt: string;
  timing: ScheduleTiming;
  timezone: string;
  enabled?: boolean;
  missedRunPolicy?: ScheduleMissedRunPolicy;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
}

export interface SchedulesResponse {
  schedules: AgentSchedule[];
  runs: ScheduleRun[];
  serverTime: string;
  health?: SchedulerHealth;
}

export interface SchedulerHealth {
  state: "healthy" | "idle";
  startedAt: string;
  lastHeartbeatAt: string;
  lastTickAt: string | null;
  nextWakeAt: string | null;
  tickCount: number;
  missedRuns: number;
}

export const ACTIVE_SCHEDULE_RUN_STATUSES = new Set<ScheduleRunStatus>([
  "running",
  "waiting_for_input",
]);
