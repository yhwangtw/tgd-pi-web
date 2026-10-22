import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllSessions } from "../session-reader";
import { durableSessionDirectory, durableSessionId, listDurableChildRuns, listDurableSessions, readDurableProjection, saveDurableProjection, type DurableSessionProjection } from "../durable-session-store";
import { publishSessionMigration } from "../session-migrations";

const activity = vi.hoisted(() => ({ root: "", active: 0, peak: 0, legacyReads: 0, legacyStats: 0, projectionReads: 0, indexReads: 0, failIndexWrite: false, replacementProjection: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).startsWith(`${activity.root}/durable-sessions/`)) {
      if (/\/[1-9][0-9]*\.json$/.test(String(args[0]))) activity.projectionReads++;
      if (String(args[0]).endsWith(".index.json")) activity.indexReads++;
    }
    return actual.readFileSync(...args);
  }, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (activity.failIndexWrite && String(args[0]).includes(".index.json.")) throw new Error("Synthetic index write failure");
    return actual.writeFileSync(...args);
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    const result = actual.renameSync(...args);
    if (activity.replacementProjection && /\/[1-9][0-9]*\.json$/.test(String(args[1]))) {
      const replacement = `${String(args[1])}.concurrent.tmp`;
      actual.writeFileSync(replacement, activity.replacementProjection);
      activity.replacementProjection = "";
      actual.renameSync(replacement, args[1]);
    }
    return result;
  } };
});
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  async function tracked<T>(path: unknown, operation: () => Promise<T>): Promise<T> {
    if (!String(path).startsWith(`${activity.root}/sessions/`)) return operation();
    activity.active++;
    activity.peak = Math.max(activity.peak, activity.active);
    try {
      // Keep operations pending for a turn so unbounded fan-out is observable.
      await new Promise<void>(resolve => setImmediate(resolve));
      return await operation();
    } finally { activity.active--; }
  }
  return { ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]).startsWith(`${activity.root}/sessions/`)) activity.legacyStats++;
      return tracked(args[0], () => actual.stat(...args));
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).startsWith(`${activity.root}/sessions/`)) activity.legacyReads++;
      return tracked(args[0], () => actual.readFile(...args));
    },
  };
});

let root: string;
let previous: string | undefined;
const group = "11111111-2222-4333-8444-555555555555";
function projection(conversation = 1): DurableSessionProjection {
  const id = durableSessionId(group, conversation);
  return { version: 1, deleted: false,
    info: { id, path: `durable://${id}`, cwd: "/fixture", created: new Date(0).toISOString(), modified: new Date(1).toISOString(), messageCount: 1, firstMessage: "fixture", lastMessage: "fixture" },
    entries: [{ id: 1, kind: "messages", model: [{ role: "user", content: "fixture", timestamp: 1 }] } as unknown as DurableSessionProjection["entries"][number]],
    agent: {}, context: { messages: [], entryIds: [], model: null, thinkingLevel: "off" },
    agentRun: { id, name: "Child", cwd: "/fixture", prompt: "fixture", toolNames: [], trigger: "subagent", status: "completed", createdAt: new Date(0).toISOString(), report: { summary: "fixture", changedFiles: [], tests: [], tools: [], usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, durationMs: 1 } },
  };
}
function legacySession(index: number): string {
  const directory = join(root, "sessions", "fixture");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${index}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id: `fixture-${index}`, timestamp: new Date(0).toISOString(), cwd: "/fixture" },
    { type: "message", id: "m1", parentId: null, timestamp: new Date(index + 1).toISOString(), message: { role: "user", content: `Message ${index}`, timestamp: index + 1 } },
  ].map(value => JSON.stringify(value)).join("\n"));
  return path;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-index-perf-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  Object.assign(activity, { root, active: 0, peak: 0, legacyReads: 0, legacyStats: 0, projectionReads: 0, indexReads: 0, failIndexWrite: false, replacementProjection: "" });
  globalThis.__piSessionInfoCache = undefined;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piSessionListings = undefined;
  globalThis.__piDurableSessionIndex = undefined;
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

describe("Durable listing metadata cache", () => {
  it("avoids reading unchanged full projections for sidebar and child-run lists without retaining transcripts", () => {
    const saved = projection();
    saveDurableProjection(durableSessionDirectory(group), 1, saved);
    globalThis.__piDurableSessionIndex = undefined; // A restarted process uses the small disk index.
    expect(listDurableSessions()).toHaveLength(1);
    expect(activity.projectionReads).toBe(0);
    expect(activity.indexReads).toBe(1);
    listDurableSessions()[0].name = "caller mutation";
    const runs = listDurableChildRuns();
    runs[0].report!.summary = "caller mutation";
    expect(listDurableSessions()[0].name).toBeUndefined();
    expect(listDurableChildRuns()[0].report!.summary).toBe("fixture");
    expect(activity.projectionReads).toBe(0);
    expect([...globalThis.__piDurableSessionIndex!.values()][0].value).not.toHaveProperty("entries");
    const first = readDurableProjection(saved.info.id)!;
    first.entries.splice(0);
    expect(readDurableProjection(saved.info.id)?.entries).toHaveLength(1);
    expect(activity.projectionReads).toBe(2);
  });

  it("refreshes renamed, externally replaced, malformed and deleted projections", () => {
    const saved = projection();
    const directory = durableSessionDirectory(group);
    const path = join(directory, "1.json");
    saveDurableProjection(directory, 1, saved);
    listDurableSessions();
    saveDurableProjection(directory, 1, { ...saved, info: { ...saved.info, name: "Renamed" } });
    expect(listDurableSessions()[0].name).toBe("Renamed");
    writeFileSync(path, JSON.stringify({ ...saved, info: { ...saved.info, name: "External update" } }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(listDurableSessions()[0].name).toBe("External update");
    writeFileSync(path, "{invalid");
    expect(listDurableSessions()).toEqual([]);
    expect(listDurableSessions()).toEqual([]);
    saveDurableProjection(directory, 1, saved);
    expect(listDurableSessions()).toHaveLength(1);
    saveDurableProjection(directory, 1, { ...saved, deleted: true });
    expect(listDurableSessions()).toEqual([]);
    rmSync(path);
    listDurableSessions();
    expect(globalThis.__piDurableSessionIndex?.size).toBe(0);
  });

  it("rechecks migration visibility when only the alias changes", () => {
    const saved = projection();
    saved.info.sourceSessionId = "legacy-fixture";
    saveDurableProjection(durableSessionDirectory(group), 1, saved);
    expect(listDurableSessions()).toEqual([]);
    const receipt = { version: 1 as const, sourceId: "legacy-fixture", sessionId: saved.info.id, sourcePath: "/fixture/source", sourceHash: "fixture", migratedAt: new Date(0).toISOString() };
    publishSessionMigration(receipt);
    expect(listDurableSessions().map(info => info.id)).toEqual([saved.info.id]);
    publishSessionMigration({ ...receipt, sessionId: durableSessionId(group, 2) });
    expect(listDurableSessions()).toEqual([]);
    expect(activity.projectionReads).toBe(0);
  });

  it("falls back without mutating legacy stores when the sidecar is absent, stale or corrupt", () => {
    const saved = projection();
    const directory = durableSessionDirectory(group);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "1.json");
    const sidecar = join(directory, "1.index.json");
    writeFileSync(path, JSON.stringify(saved));
    expect(listDurableSessions()).toHaveLength(1);
    expect(activity.projectionReads).toBe(1);
    expect(existsSync(sidecar)).toBe(false);
    saveDurableProjection(directory, 1, saved);
    globalThis.__piDurableSessionIndex = undefined;
    writeFileSync(sidecar, "{invalid");
    expect(listDurableSessions()).toHaveLength(1);
    expect(activity.projectionReads).toBe(2);
    saveDurableProjection(directory, 1, saved);
    writeFileSync(path, JSON.stringify({ ...saved, info: { ...saved.info, name: "Authoritative external edit" } }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    globalThis.__piDurableSessionIndex = undefined;
    expect(listDurableSessions()[0].name).toBe("Authoritative external edit");
    expect(activity.projectionReads).toBe(3);
  });

  it("does not associate a concurrent writer's source fingerprint with stale metadata", () => {
    const saved = projection();
    const directory = durableSessionDirectory(group);
    activity.replacementProjection = JSON.stringify({ ...saved, info: { ...saved.info, name: "Concurrent replacement" } });
    saveDurableProjection(directory, 1, saved);
    expect(listDurableSessions()[0].name).toBe("Concurrent replacement");
    expect(activity.projectionReads).toBe(1);
    expect(existsSync(join(directory, "1.index.json"))).toBe(false);
  });

  it("keeps the primary projection authoritative when the optional sidecar cannot be written", () => {
    const saved = projection();
    const directory = durableSessionDirectory(group);
    saveDurableProjection(directory, 1, saved);
    activity.failIndexWrite = true;
    expect(() => saveDurableProjection(directory, 1, { ...saved, info: { ...saved.info, name: "Committed despite index failure" } })).not.toThrow();
    globalThis.__piDurableSessionIndex = undefined;
    expect(listDurableSessions()[0].name).toBe("Committed despite index failure");
    expect(activity.projectionReads).toBe(1);
    expect(readDurableProjection(saved.info.id)?.info.name).toBe("Committed despite index failure");
  });
});

describe("legacy session listing work limits", () => {
  it("bounds simultaneous file operations and shares concurrent cold scans", async () => {
    for (let index = 0; index < 96; index++) legacySession(index);
    const [first, second] = await Promise.all([listAllSessions(), listAllSessions()]);
    expect(first).toHaveLength(96);
    expect(second).toEqual(first);
    expect(activity.peak).toBeGreaterThan(1);
    expect(activity.peak).toBeLessThanOrEqual(32);
    expect(activity.legacyReads).toBe(96);
    expect(activity.legacyStats).toBe(96);
    first[0].name = "caller mutation";
    expect(second[0].name).toBeUndefined();
    expect(activity.active).toBe(0);
    expect(globalThis.__piSessionListings?.size).toBe(0);
    await listAllSessions();
    expect(activity.legacyReads).toBe(96);
    expect(activity.legacyStats).toBe(192);
    const file = legacySession(0);
    writeFileSync(file, readFileSync(file, "utf8") + "\n" + JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "Fresh", timestamp: 1000 } }));
    expect((await listAllSessions()).find(info => info.id === "fixture-0")?.messageCount).toBe(2);
    expect(activity.legacyReads).toBe(97);
  });
});
