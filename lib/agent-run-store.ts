import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAgentRunLimits } from "./agent-run-limits";
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
const RUN_TRIGGERS = new Set(["manual", "retry", "subagent"]);

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

function isLimits(value: unknown): boolean {
  return value === undefined || isAgentRunLimits(value);
}

function isAgentRun(value: unknown): value is AgentRun {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentRun>;
  return typeof item.id === "string"
    && (item.engine === undefined || (item as { engine?: unknown }).engine === "durable")
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
    && isWorkspace(item.workspace)
    && isLimits(item.limits)
    && (item.budgetGroup === undefined || (!!item.budgetGroup && typeof item.budgetGroup.id === "string"
      && Number.isFinite(item.budgetGroup.maxCostUsd) && item.budgetGroup.maxCostUsd > 0));
}

export function agentRunStorePath(): string {
  return join(getAgentDir(), "agent-runs.json");
}

export function emptyAgentRunStore(): AgentRunStore {
  return { version: 1, runs: [] };
}

const REMOVED_ENGINE_ERROR = "Pi Durable execution was removed; this run was interrupted and will not resume automatically. Retry explicitly to start a new SDK run.";

function loadAgentRunStore(path: string, now: Date): { store: AgentRunStore; interruptedLegacyRuns: number } {
  if (!existsSync(path)) return { store: emptyAgentRunStore(), interruptedLegacyRuns: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentRunStore>;
    let interruptedLegacyRuns = 0;
    const runs = (Array.isArray(raw.runs) ? raw.runs.filter(isAgentRun).slice(0, MAX_RUNS) : []).map(value => {
      const run = { ...value };
      const legacy = (run as { engine?: unknown }).engine === "durable";
      // Preserve historical records, but never send an old execution to a new engine.
      delete run.engine;
      delete (run as { durableConversation?: boolean }).durableConversation;
      if (legacy && (run.status === "queued" || ACTIVE_AGENT_RUN_STATUSES.has(run.status))) {
        run.status = "interrupted";
        run.finishedAt = now.toISOString();
        run.error = REMOVED_ENGINE_ERROR;
        interruptedLegacyRuns++;
      }
      return run;
    });
    return {
      interruptedLegacyRuns,
      store: {
        version: 1,
        ...(isAgentRunLimits(raw.subagentLimits) ? { subagentLimits: raw.subagentLimits } : {}),
        runs,
        ...(isAgentRunConcurrency(raw.maxConcurrency) ? { maxConcurrency: raw.maxConcurrency } : {}),
      },
    };
  } catch {
    return { store: emptyAgentRunStore(), interruptedLegacyRuns: 0 };
  }
}

export function readAgentRunStore(path = agentRunStorePath()): AgentRunStore {
  return loadAgentRunStore(path, new Date()).store;
}

export function writeAgentRunStore(store: AgentRunStore, path = agentRunStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized: AgentRunStore = {
    version: 1,
    ...(isAgentRunLimits(store.subagentLimits) ? { subagentLimits: store.subagentLimits } : {}),
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
  const { store, interruptedLegacyRuns } = loadAgentRunStore(path, now);
  let changed = interruptedLegacyRuns;
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
