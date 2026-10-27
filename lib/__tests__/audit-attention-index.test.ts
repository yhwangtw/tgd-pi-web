import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttentionItems } from "../attention-center";
import { listAllSessions } from "../session-reader";
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
  it("redacts SDK failures in the sidebar index and clears recovered errors after a cold scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-attention-index-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const directory = join(root, "sessions", "fixture");
    const path = join(directory, "failure.jsonl");
    const entries: Array<Record<string, unknown>> = [
      { type: "session", version: 3, id: "sdk-failure", timestamp: at, cwd: "/repo" },
      { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: "Review", timestamp: Date.parse(at) } },
      { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [], timestamp: Date.parse(at), stopReason: "error", errorMessage: "Authorization: Bearer test-secret-123456789" } },
    ];
    const save = () => writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n"));
    try {
      mkdirSync(directory, { recursive: true });
      save();
      globalThis.__piSessionInfoCache = undefined;
      const indexed = await listAllSessions();
      expect(indexed[0].lastAssistantError?.message).toContain("[REDACTED]");
      expect(JSON.stringify(indexed)).not.toContain("test-secret");
      const attention = buildAttentionItems({ agentRuns: [], scheduleRuns: [], sessions: indexed }, new Date(at));
      expect(attention[0]).toMatchObject({ sessionId: "sdk-failure", summary: indexed[0].lastAssistantError?.message });
      expect(readFileSync(path, "utf8")).toContain("test-secret-123456789");
      globalThis.__piSessionInfoCache = undefined;
      expect((await listAllSessions())[0].lastAssistantError).toEqual(indexed[0].lastAssistantError);
      entries.push({ type: "message", id: "m3", parentId: "m2", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }], timestamp: Date.parse(at), stopReason: "stop" } });
      save();
      const recovered = await listAllSessions();
      expect(recovered[0].lastAssistantError).toBeNull();
      expect(buildAttentionItems({ agentRuns: [], scheduleRuns: [], sessions: recovered }, new Date(at))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      globalThis.__piSessionInfoCache = undefined;
      globalThis.__piSessionPathCache = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
