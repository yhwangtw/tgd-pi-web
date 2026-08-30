import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAttentionItems } from "../attention-center";
import type { AgentRun } from "../agent-run-types";
import type { ScheduleRun } from "../schedule-types";
import type { SessionInfo } from "../types";

function errorSession(id: string, modified: string, message: string): SessionInfo {
  const dir = mkdtempSync(join(tmpdir(), "pi-attention-"));
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id, timestamp: modified, cwd: dir }),
    JSON.stringify({
      type: "message", id: "a1", parentId: null, timestamp: modified,
      message: { role: "assistant", content: [], model: "test", provider: "test", stopReason: "error", errorMessage: message },
    }),
  ].join("\n"));
  return { path, id, cwd: dir, created: modified, modified, messageCount: 1, firstMessage: "failed session" };
}

describe("attention center", () => {
  it("merges waiting and failed work while deduplicating represented sessions", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const agentRuns: AgentRun[] = [{
      id: "agent-1", name: "Review", cwd: "/repo", prompt: "review", toolNames: [], trigger: "manual",
      status: "waiting_for_input", createdAt: "2026-08-10T09:00:00.000Z", sessionId: "shared",
    }];
    const scheduleRuns: ScheduleRun[] = [{
      id: "schedule-1", scheduleId: "schedule", scheduleName: "Daily", trigger: "scheduled",
      scheduledFor: "2026-08-10T08:00:00.000Z", startedAt: "2026-08-10T08:00:00.000Z",
      finishedAt: "2026-08-10T08:01:00.000Z", status: "failed", error: "quota",
    }];
    const sessions = [errorSession("shared", "2026-08-10T09:00:00.000Z", "duplicate")];

    const result = buildAttentionItems({ agentRuns, scheduleRuns, sessions }, now);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ source: "agent", status: "waiting_for_input", sessionId: "shared" });
    expect(result[1]).toMatchObject({ source: "schedule", status: "failed", summary: "quota" });
  });

  it("includes a recent standalone failed session and ignores an old one", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const recent = errorSession("recent", "2026-08-09T10:00:00.000Z", "rate limit");
    const old = errorSession("old", "2026-07-01T10:00:00.000Z", "old failure");
    const result = buildAttentionItems({ agentRuns: [], scheduleRuns: [], sessions: [recent, old] }, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "session", sessionId: "recent", summary: "rate limit" });
  });

  it("redacts credentials from attention summaries", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const session = errorSession("secret", "2026-08-10T09:00:00.000Z", "Authorization: Bearer live-token-123456789");
    const result = buildAttentionItems({ agentRuns: [], scheduleRuns: [], sessions: [session] }, now);

    expect(result[0].summary).toContain("[REDACTED]");
    expect(result[0].summary).not.toContain("live-token-123456789");
  });

  it("keeps only completions from the last 24 hours", () => {
    const now = new Date("2026-08-10T10:00:00.000Z");
    const agentRuns: AgentRun[] = [
      {
        id: "recent-agent", name: "Recent agent", cwd: "/repo", prompt: "work", toolNames: [], trigger: "manual",
        status: "completed", createdAt: "2026-08-10T07:00:00.000Z", finishedAt: "2026-08-10T08:00:00.000Z",
      },
      {
        id: "old-agent", name: "Old agent", cwd: "/repo", prompt: "work", toolNames: [], trigger: "manual",
        status: "completed", createdAt: "2026-08-08T07:00:00.000Z", finishedAt: "2026-08-08T08:00:00.000Z",
      },
    ];
    const scheduleRuns: ScheduleRun[] = [{
      id: "recent-schedule", scheduleId: "schedule", scheduleName: "Daily", trigger: "scheduled",
      scheduledFor: "2026-08-10T06:00:00.000Z", startedAt: "2026-08-10T06:00:00.000Z",
      finishedAt: "2026-08-10T06:01:00.000Z", status: "completed",
    }];

    const result = buildAttentionItems({ agentRuns, scheduleRuns, sessions: [] }, now);

    expect(result).toHaveLength(2);
    expect(result.every((item) => item.status === "completed" && item.severity === "success")).toBe(true);
    expect(result.map((item) => item.title)).toEqual(["Recent agent", "Daily"]);
  });
});
