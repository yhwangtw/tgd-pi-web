import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// listAllSessions reads PI_CODING_AGENT_DIR at call time via pi's getAgentDir,
// so pointing it at a temp dir isolates the test from the real ~/.pi.
let agentDir: string;
let sessionsDir: string;
let prevEnv: string | undefined;

function sessionFile(dir: string, filename: string, lines: object[]): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return filePath;
}

function header(id: string, cwd = "/tmp/proj", extra: object = {}) {
  return { type: "session", version: 3, id, timestamp: "2026-07-01T10:00:00.000Z", cwd, ...extra };
}

function userMessage(id: string, parentId: string | null, text: string, timestamp = 1751364000000) {
  return { type: "message", id, parentId, timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: text, timestamp } };
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-web-test-"));
  sessionsDir = join(agentDir, "sessions");
  mkdirSync(join(sessionsDir, "--tmp-proj"), { recursive: true });
  prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piSessionInfoCache = undefined;
  globalThis.__piSessionPathCache = undefined;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevEnv;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("listAllSessions", () => {
  it("returns empty list when sessions dir does not exist", async () => {
    rmSync(sessionsDir, { recursive: true, force: true });
    const { listAllSessions } = await import("../session-reader");
    expect(await listAllSessions()).toEqual([]);
  });

  it("lists sessions with header fields, name, count and first message", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    sessionFile(dir, "a.jsonl", [
      header("aaaa-1111"),
      userMessage("m1", null, "hello world"),
      { type: "session_info", id: "s1", parentId: "m1", name: "My Session" },
    ]);
    const { listAllSessions } = await import("../session-reader");
    const sessions = await listAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("aaaa-1111");
    expect(sessions[0].cwd).toBe("/tmp/proj");
    expect(sessions[0].name).toBe("My Session");
    expect(sessions[0].messageCount).toBe(1);
    expect(sessions[0].firstMessage).toBe("hello world");
  });

  it("skips files whose first entry is not a session header", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    sessionFile(dir, "orphan.jsonl", [userMessage("m1", null, "no header")]);
    sessionFile(dir, "ok.jsonl", [header("bbbb-2222"), userMessage("m1", null, "hi")]);
    const { listAllSessions } = await import("../session-reader");
    const sessions = await listAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("bbbb-2222");
  });

  it("sorts by last activity, newest first", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    sessionFile(dir, "old.jsonl", [header("old-1"), userMessage("m1", null, "old", 1000)]);
    sessionFile(dir, "new.jsonl", [header("new-1"), userMessage("m1", null, "new", 2000)]);
    const { listAllSessions } = await import("../session-reader");
    const sessions = await listAllSessions();
    expect(sessions.map((s) => s.id)).toEqual(["new-1", "old-1"]);
  });

  it("resolves parentSessionId from parentSession path", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    const parentPath = sessionFile(dir, "parent.jsonl", [header("parent-1"), userMessage("m1", null, "p", 1000)]);
    sessionFile(dir, "child.jsonl", [header("child-1", "/tmp/proj", { parentSession: parentPath }), userMessage("m1", null, "c", 2000)]);
    const { listAllSessions } = await import("../session-reader");
    const sessions = await listAllSessions();
    const child = sessions.find((s) => s.id === "child-1");
    expect(child?.parentSessionId).toBe("parent-1");
  });

  it("serves unchanged files from cache and re-parses modified ones", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    const filePath = sessionFile(dir, "a.jsonl", [header("cache-1"), userMessage("m1", null, "v1")]);
    const { listAllSessions } = await import("../session-reader");

    const first = await listAllSessions();
    expect(first[0].messageCount).toBe(1);

    // Unchanged file → cached info object is reused (same reference)
    const cachedInfo = globalThis.__piSessionInfoCache?.get(filePath)?.info;
    await listAllSessions();
    expect(globalThis.__piSessionInfoCache?.get(filePath)?.info).toBe(cachedInfo);

    // Modified file (different size + mtime) → re-parsed
    sessionFile(dir, "a.jsonl", [
      header("cache-1"),
      userMessage("m1", null, "v1"),
      userMessage("m2", "m1", "v2"),
    ]);
    utimesSync(filePath, new Date(), new Date(Date.now() + 5000));
    const second = await listAllSessions();
    expect(second[0].messageCount).toBe(2);
  });

  it("evicts deleted files from the cache", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    const filePath = sessionFile(dir, "gone.jsonl", [header("gone-1"), userMessage("m1", null, "x")]);
    const { listAllSessions } = await import("../session-reader");
    await listAllSessions();
    expect(globalThis.__piSessionInfoCache?.has(filePath)).toBe(true);

    rmSync(filePath);
    const after = await listAllSessions();
    expect(after).toHaveLength(0);
    expect(globalThis.__piSessionInfoCache?.has(filePath)).toBe(false);
  });

  it("does not resolve a cached future path until the session file exists", async () => {
    const dir = join(sessionsDir, "--tmp-proj");
    const futurePath = join(dir, "future.jsonl");
    const { cacheSessionPath, resolveSessionPath } = await import("../session-reader");

    cacheSessionPath("future-1", futurePath);
    expect(await resolveSessionPath("future-1")).toBeNull();
    expect(globalThis.__piSessionPathCache?.has("future-1")).toBe(false);

    sessionFile(dir, "future.jsonl", [header("future-1")]);
    expect(await resolveSessionPath("future-1")).toBe(futurePath);
  });
});
