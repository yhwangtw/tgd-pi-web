export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AgentRunTrigger = "manual" | "retry";

export interface AgentRunWorkspace {
  repoRoot: string;
  branch: string | null;
  isMain: boolean;
}

export interface AgentRunInput {
  name: string;
  cwd: string;
  prompt: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames: string[];
  workspace?: AgentRunWorkspace;
}

export interface AgentRunReport {
  summary: string;
  changedFiles: string[];
  tests: Array<{ name: string; status: "passed" | "failed" | "run" }>;
  tools: string[];
  usage: { inputTokens: number; outputTokens: number; cost: number };
  durationMs: number | null;
}

export interface AgentRun extends AgentRunInput {
  id: string;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  parentRunId?: string;
  error?: string;
  report?: AgentRunReport;
}

export interface AgentRunStore {
  version: 1;
  runs: AgentRun[];
  maxConcurrency?: number;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
  counts: Record<AgentRunStatus, number>;
  maxConcurrency: number;
  serverTime: string;
  nextCursor: string | null;
}

export const ACTIVE_AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  "running",
  "waiting_for_input",
]);

export const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const MIN_AGENT_RUN_CONCURRENCY = 1;
export const MAX_AGENT_RUN_CONCURRENCY = 8;
export const DEFAULT_AGENT_RUN_CONCURRENCY = 3;

export function isAgentRunConcurrency(value: unknown): value is number {
  return Number.isInteger(value)
    && Number(value) >= MIN_AGENT_RUN_CONCURRENCY
    && Number(value) <= MAX_AGENT_RUN_CONCURRENCY;
}
