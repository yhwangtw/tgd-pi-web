import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  isAgentRunConcurrency,
  type AgentRun,
  type AgentRunStatus,
  type AgentRunStore,
} from "./agent-run-types";

const MAX_RUNS = 1_000;
const RUN_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const RUN_TRIGGERS = new Set(["manual", "retry"]);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isWorkspace(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const workspace = value as Record<string, unknown>;
  return typeof workspace.repoRoot === "string"
    && (workspace.branch === null || typeof workspace.branch === "string")
    && typeof workspace.isMain === "boolean";
}

function isReport(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return typeof report.summary === "string"
    && Array.isArray(report.changedFiles)
    && report.changedFiles.every((item) => typeof item === "string")
    && Array.isArray(report.tests)
    && Array.isArray(report.tools)
    && report.tools.every((item) => typeof item === "string")
    && typeof report.usage === "object"
    && (report.durationMs === null || typeof report.durationMs === "number");
}

function isAgentRun(value: unknown): value is AgentRun {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentRun>;
  return typeof item.id === "string"
    && typeof item.name === "string"
    && typeof item.cwd === "string"
    && typeof item.prompt === "string"
    && RUN_TRIGGERS.has(item.trigger ?? "")
    && RUN_STATUSES.has(item.status as AgentRunStatus)
    && typeof item.createdAt === "string"
    && Array.isArray(item.toolNames)
    && item.toolNames.every((tool) => typeof tool === "string")
    && isOptionalString(item.provider)
    && isOptionalString(item.modelId)
    && (!!item.provider === !!item.modelId)
    && isOptionalString(item.thinkingLevel)
    && isOptionalString(item.startedAt)
    && isOptionalString(item.finishedAt)
    && isOptionalString(item.sessionId)
    && isOptionalString(item.parentRunId)
    && isOptionalString(item.error)
    && isReport(item.report)
    && isWorkspace(item.workspace);
}

export function agentRunStorePath(): string {
  return join(getAgentDir(), "agent-runs.json");
}

export function emptyAgentRunStore(): AgentRunStore {
  return { version: 1, runs: [] };
}

export function readAgentRunStore(path = agentRunStorePath()): AgentRunStore {
  if (!existsSync(path)) return emptyAgentRunStore();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentRunStore>;
    return {
      version: 1,
      runs: Array.isArray(raw.runs) ? raw.runs.filter(isAgentRun).slice(0, MAX_RUNS) : [],
      ...(isAgentRunConcurrency(raw.maxConcurrency)
        ? { maxConcurrency: raw.maxConcurrency }
        : {}),
    };
  } catch {
    return emptyAgentRunStore();
  }
}

export function writeAgentRunStore(store: AgentRunStore, path = agentRunStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized: AgentRunStore = {
    version: 1,
    runs: store.runs.slice(0, MAX_RUNS),
    ...(isAgentRunConcurrency(store.maxConcurrency)
      ? { maxConcurrency: store.maxConcurrency }
      : {}),
  };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, path);
}

export function mutateAgentRunStore<T>(
  mutate: (store: AgentRunStore) => T,
  path = agentRunStorePath(),
): T {
  const store = readAgentRunStore(path);
  const result = mutate(store);
  writeAgentRunStore(store, path);
  return result;
}

export function reconcileInterruptedAgentRuns(
  path = agentRunStorePath(),
  now = new Date(),
): number {
  const store = readAgentRunStore(path);
  let changed = 0;
  for (const run of store.runs) {
    if (!ACTIVE_AGENT_RUN_STATUSES.has(run.status)) continue;
    run.status = "interrupted";
    run.finishedAt = now.toISOString();
    run.error = "The agent daemon restarted before this run completed";
    changed++;
  }
  if (changed > 0) writeAgentRunStore(store, path);
  return changed;
}
