import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionSearchIndex, SESSION_SEARCH_INDEX_LIMITS } from "../session-search-index";
import { getSessionEntries, listAllSessions } from "../session-reader";
import { getSessionSearchMetadata, searchPreparedSession, searchSessionEntries } from "../session-search";
import { publishSessionMigration } from "../session-migrations";
import { GET } from "../../app/api/sessions/search/route";

const activity = vi.hoisted(() => ({
  root: "", reads: 0, parses: 0, active: 0, peak: 0, failReads: 0,
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (!String(args[0]).startsWith(`${activity.root}/sessions/`)) return actual.readFile(...args);
    activity.reads++;
    activity.active++;
    activity.peak = Math.max(activity.peak, activity.active);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (activity.failReads > 0) { activity.failReads--; throw new Error("Synthetic read failure"); }
      const result = await actual.readFile(...args);
      const afterRead = activity.afterRead;
      activity.afterRead = undefined;
      afterRead?.();
      return result;
    } finally { activity.active--; }
  } };
});
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, parseSessionEntries: (...args: Parameters<typeof actual.parseSessionEntries>) => {
    activity.parses++;
    return actual.parseSessionEntries(...args);
  } };
});

let root: string;
let previous: string | undefined;
const timestamp = "2026-10-22T00:00:00.000Z";
function fixture(index: number, options: { id?: string; content?: string; version?: number; agentDir?: string } = {}): string {
  const directory = join(options.agentDir ?? root, "sessions", "--fixture");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${index}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: options.version ?? 3, id: options.id ?? `search-${index}`, cwd: "/fixture", timestamp },
    { type: "model_change", id: "model", parentId: null, timestamp, provider: "fixture", modelId: "offline" },
    { type: "message", ...(options.version === 1 ? {} : { id: "first", parentId: "model" }), timestamp, message: { role: "user", content: options.content ?? `Alpha question ${index}`, timestamp: index + 1 } },
    { type: "message", id: "branch-a", parentId: "first", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Beta answer on the first branch" }, { type: "toolCall", name: "read", arguments: { hidden: "private tool payload" } }], stopReason: "stop", timestamp: index + 2 } },
    { type: "message", id: "branch-b", parentId: "first", timestamp, message: { role: "assistant", content: ["Beta answer on the other branch", { type: "image", data: "private image payload" }], stopReason: "aborted", timestamp: index + 3 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  return path;
}
function append(path: string, content: string) {
  appendFileSync(path, JSON.stringify({ type: "message", id: `appended-${content}`, parentId: "branch-b", timestamp, message: { role: "assistant", content, stopReason: "error", timestamp: 1000 } }) + "\n");
}
async function request(query: string, extra = "") {
  const response = await GET(new Request(`http://localhost/?q=${encodeURIComponent(query)}${extra}`));
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-search-index-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  Object.assign(activity, { root, reads: 0, parses: 0, active: 0, peak: 0, failReads: 0, afterRead: undefined });
  globalThis.__piSessionInfoCache = undefined;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piSessionListings = undefined;
  globalThis.__piSessionSearchIndex = undefined;
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  globalThis.__piSessionSearchIndex = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("bounded session search index", () => {
  it("shares concurrent reads and keeps only immutable searchable data from all branches", async () => {
    const path = fixture(0);
    const before = readFileSync(path, "utf8");
    const index = getSessionSearchIndex([path]);
    const [first, second] = await Promise.all([index.read(path), index.read(path)]);
    expect(first).toBe(second);
    expect(activity.reads).toBe(1);
    expect(activity.parses).toBe(1);
    const entries = getSessionEntries(path);
    expect(first?.metadata).toEqual(getSessionSearchMetadata(entries));
    expect(searchPreparedSession(first!, "beta")).toEqual(searchSessionEntries(entries, "beta"));
    expect(searchPreparedSession(first!, "beta").map(match => match.entryId)).toEqual(["branch-a", "branch-b"]);
    expect(JSON.stringify(first)).not.toContain("private tool payload");
    expect(JSON.stringify(first)).not.toContain("private image payload");
    expect(Object.isFrozen(first?.messages)).toBe(true);
    expect(Object.isFrozen(first?.messages[0])).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("migrates legacy data in memory and leaves empty/corrupted files unchanged", async () => {
    const legacy = fixture(0, { version: 1 });
    const empty = join(root, "sessions", "--fixture", "empty.jsonl");
    const corrupted = join(root, "sessions", "--fixture", "corrupted.jsonl");
    writeFileSync(empty, "");
    writeFileSync(corrupted, "{not-json\n");
    const paths = [legacy, empty, corrupted];
    const originals = paths.map(path => readFileSync(path, "utf8"));
    const index = getSessionSearchIndex(paths);
    const data = await index.read(legacy);
    expect(searchPreparedSession(data!, "alpha")[0].entryId).toBeTruthy();
    expect((await index.read(empty))?.messages).toEqual([]);
    expect((await index.read(corrupted))?.messages).toEqual([]);
    expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(originals);
  });

  it("refreshes append and replacement revisions, including preserved size and mtime", async () => {
    const path = fixture(0);
    const index = getSessionSearchIndex([path]);
    expect(searchPreparedSession((await index.read(path))!, "fresh")).toEqual([]);
    append(path, "Fresh appended result");
    const appended = await index.read(path);
    expect(searchPreparedSession(appended!, "fresh")).toHaveLength(1);
    expect(appended?.metadata.status).toBe("failed");
    const time = 1_700_000_000;
    utimesSync(path, time, time);
    await index.read(path);
    const before = statSync(path);
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, readFileSync(path, "utf8").replaceAll("Fresh appended result", "Newer replaced result"));
    utimesSync(replacement, time, time);
    renameSync(replacement, path);
    expect(statSync(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
    expect(searchPreparedSession((await index.read(path))!, "newer")).toHaveLength(1);
    const sameInode = statSync(path).ino;
    await new Promise(resolve => setTimeout(resolve, 10));
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("Newer replaced result", "Later replaced result"));
    utimesSync(path, time, time);
    expect(statSync(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs, ino: sameInode });
    expect(searchPreparedSession((await index.read(path))!, "later")).toHaveLength(1);
    expect(activity.reads).toBe(5);
  });

  it("does not retain a file changed during its read and retries transient failures", async () => {
    const path = fixture(0);
    const index = getSessionSearchIndex([path]);
    activity.afterRead = () => append(path, "Concurrent fresh result");
    const old = await index.read(path);
    expect(searchPreparedSession(old!, "concurrent")).toEqual([]);
    expect(globalThis.__piSessionSearchIndex?.entries.has(path)).toBe(false);
    expect(searchPreparedSession((await index.read(path))!, "concurrent")).toHaveLength(1);
    append(path, "Another revision");
    activity.failReads = 1;
    expect(await index.read(path)).toBeNull();
    expect(searchPreparedSession((await index.read(path))!, "another")).toHaveLength(1);
    expect(activity.reads).toBe(4);
  });

  it("bounds pending file builds and retained file count while preserving evicted results", async () => {
    const paths = Array.from({ length: SESSION_SEARCH_INDEX_LIMITS.maxEntries + 1 }, (_, i) => fixture(i));
    const index = getSessionSearchIndex(paths);
    const data = await Promise.all(paths.map(path => index.read(path)));
    expect(data.every(Boolean)).toBe(true);
    expect(activity.reads).toBe(paths.length);
    expect(activity.parses).toBe(paths.length);
    expect(activity.peak).toBeGreaterThan(1);
    expect(activity.peak).toBeLessThanOrEqual(SESSION_SEARCH_INDEX_LIMITS.maxPending);
    const state = globalThis.__piSessionSearchIndex!;
    expect(state.entries.size).toBe(SESSION_SEARCH_INDEX_LIMITS.maxEntries);
    expect(state.pending.size).toBe(0);
    expect(state.bytes).toBeLessThanOrEqual(SESSION_SEARCH_INDEX_LIMITS.maxBytes);
    const evicted = paths.find(path => !state.entries.has(path))!;
    expect(searchPreparedSession((await index.read(evicted))!, "alpha")).toHaveLength(1);
    expect(activity.reads).toBe(paths.length + 1);
    expect(state.entries.size).toBe(SESSION_SEARCH_INDEX_LIMITS.maxEntries);
  });

  it("bounds retained bytes and serves oversized sessions in full without retaining them", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => fixture(i, { content: `${"x".repeat(900_000)} needle-${i}` }));
    const index = getSessionSearchIndex(paths);
    for (const path of paths) expect(await index.read(path)).not.toBeNull();
    const state = globalThis.__piSessionSearchIndex!;
    expect(state.bytes).toBeLessThanOrEqual(SESSION_SEARCH_INDEX_LIMITS.maxBytes);
    expect(state.entries.size).toBeLessThan(paths.length);
    const oversized = fixture(99, { content: `${"x".repeat(SESSION_SEARCH_INDEX_LIMITS.maxEntryBytes)} complete-tail` });
    const next = getSessionSearchIndex([...paths, oversized]);
    const before = activity.reads;
    for (let i = 0; i < 2; i++) expect(searchPreparedSession((await next.read(oversized))!, "complete-tail")).toHaveLength(1);
    expect(activity.reads).toBe(before + 2);
    expect(state.entries.has(oversized)).toBe(false);
    expect(state.bytes).toBeLessThanOrEqual(SESSION_SEARCH_INDEX_LIMITS.maxBytes);
  });
});

describe("indexed session search route", () => {
  it("reuses file content and parsing across distinct warm queries with unchanged result fields", async () => {
    const path = fixture(0);
    const before = readFileSync(path, "utf8");
    await request("alpha");
    const reads = activity.reads;
    const parses = activity.parses;
    const result = await request(" beta ");
    expect(activity.reads).toBe(reads);
    expect(activity.parses).toBe(parses);
    expect(result).toMatchObject({ query: "beta", scanned: 1, totalHits: 1, resultsLimited: false, truncated: false });
    expect(result.hits).toEqual([expect.objectContaining({
      id: "search-0", cwd: "/fixture", firstMessage: "Alpha question 0", messageCount: 3,
      provider: "fixture", modelId: "offline", status: "interrupted", matchedIn: "messages", totalMatches: 2,
      matches: searchSessionEntries(getSessionEntries(path), "beta"),
    })]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("preserves name/opening relevance, eight-match cap, scan/result limits and empty query behavior", async () => {
    const named = fixture(0, { content: "Opening without the term" });
    appendFileSync(named, JSON.stringify({ type: "session_info", id: "name", parentId: "branch-b", timestamp, name: "Needle title" }) + "\n");
    fixture(1, { content: "Needle opening" });
    const body = fixture(2, { content: "Unrelated opening" });
    for (let i = 0; i < 12; i++) append(body, `Needle body ${i}`);
    const result = await request("needle");
    expect(result.hits.map((hit: { id: string }) => hit.id)).toEqual(["search-0", "search-1", "search-2"]);
    expect(result.hits.map((hit: { matchedIn: string }) => hit.matchedIn)).toEqual(["name", "firstMessage", "messages"]);
    expect(result.hits[2]).toMatchObject({ totalMatches: 8, matches: expect.any(Array) });
    expect(result.hits[2].matches).toHaveLength(8);
    expect(await request("needle", "&resultLimit=1")).toMatchObject({ totalHits: 3, resultsLimited: true, scanned: 3 });
    expect((await request("needle", "&resultLimit=1")).hits).toHaveLength(1);
    expect(await request("needle", "&limit=1")).toMatchObject({ scanned: 1, truncated: true });
    const reads = activity.reads;
    const parses = activity.parses;
    expect(await request("   ")).toEqual({ hits: [], truncated: false, query: "" });
    expect(activity.reads).toBe(reads);
    expect(activity.parses).toBe(parses);
  });

  it("prunes migrated/deleted paths and isolates agent-directory changes", async () => {
    const source = fixture(0);
    const target = fixture(1, { id: "dw_saved-target" });
    expect((await request("alpha")).totalHits).toBe(2);
    publishSessionMigration({ version: 1, sourceId: "search-0", sessionId: "dw_saved-target", sourcePath: source, sourceHash: "fixture", migratedAt: timestamp });
    expect((await request("alpha")).hits.map((hit: { id: string }) => hit.id)).toEqual(["dw_saved-target"]);
    expect(globalThis.__piSessionSearchIndex?.entries.has(source)).toBe(false);
    rmSync(target);
    expect((await request("alpha")).hits).toEqual([]);
    expect(globalThis.__piSessionSearchIndex?.entries.size).toBe(0);
    const oldState = globalThis.__piSessionSearchIndex!;
    const other = join(root, "other-agent");
    fixture(0, { agentDir: other, content: "Gamma directory question" });
    process.env.PI_CODING_AGENT_DIR = other;
    expect((await request("alpha")).hits).toEqual([]);
    expect((await request("gamma")).hits).toEqual([expect.objectContaining({ id: "search-0", firstMessage: "Gamma directory question" })]);
    expect(globalThis.__piSessionSearchIndex).not.toBe(oldState);
    expect(oldState.active).toBe(false);
    expect(oldState.entries.size).toBe(0);
    expect(await listAllSessions()).toHaveLength(1);
  });
});
