import { readAgentRunStore } from "./agent-run-store";
import { readScheduleStore } from "./schedule-store";
import { listAllSessions, readSessionFile } from "./session-reader";
import type { AssistantMessage } from "./types";
import type { AgentRun } from "./agent-run-types";
import type { ScheduleRun } from "./schedule-types";
import type { SessionInfo } from "./types";

export type AttentionSource = "agent" | "schedule" | "session";
export type AttentionSeverity = "warning" | "error";

export interface AttentionItem {
  id: string;
  source: AttentionSource;
  severity: AttentionSeverity;
  status: "waiting_for_input" | "failed" | "interrupted";
  title: string;
  summary: string;
  occurredAt: string;
  cwd?: string;
  sessionId?: string;
}

export interface AttentionResponse {
  items: AttentionItem[];
  serverTime: string;
}

const SESSION_ERROR_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const SESSION_SCAN_LIMIT = 60;

function assistantErrorFromSession(path: string): { message: string; at?: string } | null {
  const { entries } = readSessionFile(path);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    if (message.stopReason !== "error") return null;
    return {
      message: message.errorMessage?.trim() || "Model call failed",
      at: entry.timestamp,
    };
  }
  return null;
}

/**
 * Build the durable, cross-surface inbox from persisted run/session stores.
 * Read state intentionally stays client-local: one browser acknowledging an
 * item should not hide it for another device that has not seen it yet.
 */
export function buildAttentionItems(input: {
  agentRuns: AgentRun[];
  scheduleRuns: ScheduleRun[];
  sessions: SessionInfo[];
}, now = new Date()): AttentionItem[] {
  const items: AttentionItem[] = [];
  const representedSessions = new Set<string>();

  for (const run of input.agentRuns) {
    if (run.status !== "waiting_for_input" && run.status !== "failed" && run.status !== "interrupted") continue;
    if (run.sessionId) representedSessions.add(run.sessionId);
    const occurredAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
    items.push({
      id: `agent:${run.id}:${run.status}`,
      source: "agent",
      severity: run.status === "waiting_for_input" ? "warning" : "error",
      status: run.status,
      title: run.name,
      summary: run.status === "waiting_for_input"
        ? "The agent is waiting for your decision"
        : run.error?.trim() || "The agent run did not complete",
      occurredAt,
      cwd: run.cwd,
      sessionId: run.sessionId,
    });
  }

  for (const run of input.scheduleRuns) {
    if (run.status !== "waiting_for_input" && run.status !== "failed" && run.status !== "skipped") continue;
    if (run.sessionId) representedSessions.add(run.sessionId);
    items.push({
      id: `schedule:${run.id}:${run.status}`,
      source: "schedule",
      severity: run.status === "waiting_for_input" ? "warning" : "error",
      status: run.status === "waiting_for_input" ? "waiting_for_input" : "failed",
      title: run.scheduleName,
      summary: run.status === "waiting_for_input"
        ? "The scheduled agent is waiting for your decision"
        : run.error?.trim() || (run.status === "skipped" ? "The scheduled run was skipped" : "The scheduled run failed"),
      occurredAt: run.finishedAt ?? run.startedAt,
      sessionId: run.sessionId,
    });
  }

  const minimumModified = now.getTime() - SESSION_ERROR_AGE_MS;
  const sessions = input.sessions
    .filter((session) => Date.parse(session.modified) >= minimumModified)
    .slice(0, SESSION_SCAN_LIMIT);
  for (const session of sessions) {
    if (representedSessions.has(session.id)) continue;
    const error = assistantErrorFromSession(session.path);
    if (!error) continue;
    items.push({
      id: `session:${session.id}:${error.at ?? session.modified}`,
      source: "session",
      severity: "error",
      status: "failed",
      title: session.name || session.firstMessage || "Session failed",
      summary: error.message,
      occurredAt: error.at ?? session.modified,
      cwd: session.cwd,
      sessionId: session.id,
    });
  }

  return items.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
}

export async function collectAttentionItems(now = new Date()): Promise<AttentionItem[]> {
  const [sessions, agentStore, scheduleStore] = await Promise.all([
    listAllSessions(),
    Promise.resolve(readAgentRunStore()),
    Promise.resolve(readScheduleStore()),
  ]);
  return buildAttentionItems({
    agentRuns: agentStore.runs,
    scheduleRuns: scheduleStore.runs,
    sessions,
  }, now);
}
