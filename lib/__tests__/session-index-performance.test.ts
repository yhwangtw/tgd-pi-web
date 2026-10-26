import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllSessions } from "../session-reader";
import { publishSessionMigration } from "../session-migrations";

const activity = vi.hoisted(() => ({ root: "", active: 0, peak: 0, sdkReads: 0, sdkStats: 0, migrationReads: 0, failMigrationEnumeration: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).startsWith(`${activity.root}/session-migrations/`)) activity.migrationReads++;
    return actual.readFileSync(...args);
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
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      if (activity.failMigrationEnumeration && String(args[0]) === `${activity.root}/session-migrations`) {
        return Promise.reject(Object.assign(new Error("Synthetic directory read failure"), { code: "EACCES" }));
      }
      return actual.readdir(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]).startsWith(`${activity.root}/sessions/`)) activity.sdkStats++;
      return tracked(args[0], () => actual.stat(...args));
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).startsWith(`${activity.root}/sessions/`)) activity.sdkReads++;
      return tracked(args[0], () => actual.readFile(...args));
    },
  };
});

let root: string;
let previous: string | undefined;
function sdkSession(index: number, parentSession?: string, id = `fixture-${index}`): string {
  const directory = join(root, "sessions", "fixture");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${index}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/fixture", ...(parentSession ? { parentSession } : {}) },
    { type: "message", id: "m1", parentId: null, timestamp: new Date(index + 1).toISOString(), message: { role: "user", content: `Message ${index}`, timestamp: index + 1 } },
  ].map(value => JSON.stringify(value)).join("\n"));
  return path;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-index-perf-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  Object.assign(activity, { root, active: 0, peak: 0, sdkReads: 0, sdkStats: 0, migrationReads: 0, failMigrationEnumeration: false });
  globalThis.__piSessionInfoCache = undefined;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piSessionListings = undefined;
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

describe("SDK session listing work limits", () => {
  it("bounds simultaneous file operations and shares concurrent cold scans", async () => {
    for (let index = 0; index < 96; index++) sdkSession(index);
    const [first, second] = await Promise.all([listAllSessions(), listAllSessions()]);
    expect(first).toHaveLength(96);
    expect(second).toEqual(first);
    expect(activity.peak).toBeGreaterThan(1);
    expect(activity.peak).toBeLessThanOrEqual(32);
    expect(activity.sdkReads).toBe(96);
    expect(activity.sdkStats).toBe(96);
    expect(activity.migrationReads).toBe(0);
    first[0].name = "caller mutation";
    expect(second[0].name).toBeUndefined();
    expect(activity.active).toBe(0);
    expect(globalThis.__piSessionListings?.size).toBe(0);
    await listAllSessions();
    expect(activity.sdkReads).toBe(96);
    expect(activity.sdkStats).toBe(192);
    expect(activity.migrationReads).toBe(0);
    const file = sdkSession(0);
    writeFileSync(file, readFileSync(file, "utf8") + "\n" + JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "Fresh", timestamp: 1000 } }));
    expect((await listAllSessions()).find(info => info.id === "fixture-0")?.messageCount).toBe(2);
    expect(activity.sdkReads).toBe(97);
  });

  it("rechecks aliases and parent links on warm scans, without resurrecting deleted targets", async () => {
    const sourcePath = sdkSession(0);
    sdkSession(1, sourcePath);
    const firstId = "dw_saved-first";
    sdkSession(2, undefined, firstId);
    expect((await listAllSessions()).map(info => info.id).sort()).toEqual(["fixture-0", "fixture-1", firstId].sort());
    const receipt = { version: 1 as const, sourceId: "fixture-0", sessionId: firstId, sourcePath, sourceHash: "fixture", migratedAt: new Date(0).toISOString() };
    publishSessionMigration(receipt);
    const migrated = await listAllSessions();
    expect(migrated.map(info => info.id).sort()).toEqual(["fixture-1", firstId].sort());
    expect(migrated.find(info => info.id === "fixture-1")?.parentSessionId).toBe(firstId);
    const secondId = "dw_saved-second";
    const secondPath = sdkSession(3, undefined, secondId);
    publishSessionMigration({ ...receipt, sourceId: firstId, sessionId: secondId });
    const redirected = await listAllSessions();
    expect(redirected.map(info => info.id).sort()).toEqual(["fixture-1", secondId].sort());
    expect(redirected.find(info => info.id === "fixture-1")?.parentSessionId).toBe(secondId);
    rmSync(secondPath);
    const deleted = await listAllSessions();
    expect(deleted.map(info => info.id)).toEqual(["fixture-1"]);
    expect(deleted[0].parentSessionId).toBe(secondId);
    expect(activity.sdkReads).toBe(4);
  });

  it("validates receipts rather than trusting filenames and preserves aliases on enumeration failure", async () => {
    const sourcePath = sdkSession(0);
    const targetId = "dw_saved-target";
    sdkSession(1, undefined, targetId);
    publishSessionMigration({ version: 1, sourceId: "fixture-0", sessionId: targetId, sourcePath, sourceHash: "fixture", migratedAt: new Date(0).toISOString() });
    activity.failMigrationEnumeration = true;
    expect((await listAllSessions()).map(info => info.id)).toEqual([targetId]);
    expect(activity.migrationReads).toBeGreaterThan(0);
    activity.failMigrationEnumeration = false;
    const { migrationDirectory, migrationKey } = await import("../session-migrations");
    const receiptPath = join(migrationDirectory(), `${migrationKey("fixture-0")}.json`);
    writeFileSync(receiptPath, "{invalid");
    expect((await listAllSessions()).map(info => info.id).sort()).toEqual(["fixture-0", targetId].sort());
    rmSync(receiptPath);
    writeFileSync(join(migrationDirectory(), `${migrationKey("fixture-0")}.standard`), "1");
    const reads = activity.migrationReads;
    expect(await listAllSessions()).toHaveLength(2);
    expect(activity.migrationReads).toBe(reads);
  });

  it("invalidates same-size external replacements even when their original mtime is preserved", async () => {
    const path = sdkSession(0);
    const timestamp = 1_700_000_000;
    utimesSync(path, timestamp, timestamp);
    const before = statSync(path);
    expect((await listAllSessions())[0].firstMessage).toBe("Message 0");
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, readFileSync(path, "utf8").replace("Message 0", "Changed 0"));
    utimesSync(replacement, timestamp, timestamp);
    renameSync(replacement, path);
    expect(statSync(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
    expect((await listAllSessions())[0].firstMessage).toBe("Changed 0");
    expect(activity.sdkReads).toBe(2);
    rmSync(path);
    expect(await listAllSessions()).toEqual([]);
    expect(globalThis.__piSessionInfoCache?.has(path)).toBe(false);
  });
});
