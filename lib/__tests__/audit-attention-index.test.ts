import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAttentionItems } from "../attention-center";
import { durableSessionId, durableSessionDirectory, saveDurableProjection, listDurableSessions, type DurableSessionProjection } from "../durable-session-store";
import type { SessionInfo } from "../types";
const at = "2026-10-23T00:00:00.000Z";
const info: SessionInfo = { id: "cached", path: "/nonexistent/never-read.jsonl", cwd: "/repo", created: at, modified: at, messageCount: 1, firstMessage: "hello" };
describe("indexed attention failures", () => {
  it("uses cached healthy and failed outcomes without needing the transcript", () => {
    const items = buildAttentionItems({ agentRuns: [], scheduleRuns: [], sessions: [
      { ...info, id: "healthy", lastAssistantError: null },
      { ...info, lastAssistantError: { message: "rate limit", at } },
    ] }, new Date(at));
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ sessionId: "cached", summary: "rate limit" });
  });
  it("persists redacted Durable failures, reads the disk index cold, and clears recovered errors", () => {
    const group = randomUUID(), id = durableSessionId(group, 1), directory = durableSessionDirectory(group);
    const projection = { version: 1, deleted: false, info: { ...info, id }, entries: [
      { id: 1, kind: "messages", model: [{ role: "assistant", content: [], timestamp: Date.parse(at), stopReason: "error", errorMessage: "Authorization: Bearer test-secret-123456789" }] },
    ], agent: {}, context: {} } as unknown as DurableSessionProjection;
    saveDurableProjection(directory, 1, projection);
    globalThis.__piDurableSessionIndex?.clear();
    const failure = listDurableSessions().find(item => item.id === id)?.lastAssistantError;
    expect(failure?.message).toContain("[REDACTED]"); expect(failure?.message).not.toContain("test-secret");
    expect(JSON.parse(readFileSync(join(directory, "1.index.json"), "utf8")).version).toBe(2);
    projection.entries.push({ id: 2, kind: "messages", model: [{ role: "assistant", content: [], timestamp: Date.parse(at), stopReason: "stop" }] } as unknown as typeof projection.entries[number]);
    saveDurableProjection(directory, 1, projection);
    globalThis.__piDurableSessionIndex?.clear();
    expect(listDurableSessions().find(item => item.id === id)?.lastAssistantError).toBeNull();
  });
});
