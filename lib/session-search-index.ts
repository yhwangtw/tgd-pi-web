import { getAgentDir, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";
import type { SessionEntry, SessionHeader } from "./types";
import { prepareSessionSearch, type PreparedSessionSearch } from "./session-search";

export const SESSION_SEARCH_INDEX_LIMITS = Object.freeze({
  maxEntries: 500,
  maxBytes: 32 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  maxPending: 8,
});

interface CachedSearch {
  revision: string;
  data: PreparedSessionSearch;
  bytes: number;
}

interface PendingSearch {
  revision: string;
  cacheable: boolean;
  promise: Promise<PreparedSessionSearch | null>;
}

interface SearchIndexState {
  agentDir: string;
  active: boolean;
  entries: Map<string, CachedSearch>;
  pending: Map<string, PendingSearch>;
  bytes: number;
}

declare global {
  var __piSessionSearchIndex: SearchIndexState | undefined;
}

function revisionOf(value: Stats): string {
  // ctime and inode catch same-size replacements whose original mtime is restored.
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
}

function evict(state: SearchIndexState, filePath: string): void {
  const cached = state.entries.get(filePath);
  if (!cached) return;
  state.bytes -= cached.bytes;
  state.entries.delete(filePath);
}

function retain(state: SearchIndexState, filePath: string, revision: string, data: PreparedSessionSearch): void {
  const bytes = data.byteSize + 128 + 2 * (filePath.length + revision.length);
  // Large sessions still search in full, but cannot monopolize retained memory.
  if (bytes > SESSION_SEARCH_INDEX_LIMITS.maxEntryBytes) return;
  evict(state, filePath);
  while (state.entries.size >= SESSION_SEARCH_INDEX_LIMITS.maxEntries || state.bytes + bytes > SESSION_SEARCH_INDEX_LIMITS.maxBytes) {
    const oldest = state.entries.keys().next().value;
    if (oldest === undefined) break;
    evict(state, oldest);
  }
  state.entries.set(filePath, { revision, data, bytes });
  state.bytes += bytes;
}

async function buildSearchData(state: SearchIndexState, filePath: string, pending: PendingSearch): Promise<PreparedSessionSearch | null> {
  try {
    // Both SDK operations are pure/in-memory. SessionManager.open() must never
    // be used here: opening an empty or corrupted history can rewrite it.
    const parsed = parseSessionEntries(await readFile(filePath, "utf8")) as unknown as Array<SessionHeader | SessionEntry>;
    migrateSessionEntries(parsed as never);
    const data = prepareSessionSearch(parsed.filter((entry): entry is SessionEntry => entry.type !== "session"));
    const after = await stat(filePath);
    // Do not retain a snapshot changed during the read, a removed/migrated path,
    // or an index belonging to a previously active agent directory.
    if (state.active && pending.cacheable && revisionOf(after) === pending.revision) {
      retain(state, filePath, pending.revision, data);
    }
    return data;
  } catch {
    evict(state, filePath);
    return null;
  }
}

async function readSearchData(state: SearchIndexState, filePath: string): Promise<PreparedSessionSearch | null> {
  let revision: string;
  try {
    const current = await stat(filePath);
    if (!current.isFile()) throw new Error("Not a session file");
    revision = revisionOf(current);
  } catch {
    evict(state, filePath);
    const pending = state.pending.get(filePath);
    if (pending) pending.cacheable = false;
    return null;
  }

  const cached = state.entries.get(filePath);
  if (cached?.revision === revision) {
    // Map insertion order provides bounded least-recently-used eviction.
    state.entries.delete(filePath);
    state.entries.set(filePath, cached);
    return cached.data;
  }
  evict(state, filePath);

  const existing = state.pending.get(filePath);
  if (existing) {
    if (existing.revision === revision) return existing.promise;
    await existing.promise;
    return readSearchData(state, filePath);
  }
  if (state.pending.size >= SESSION_SEARCH_INDEX_LIMITS.maxPending) {
    // Wait before admitting another file; do not retain an archive-sized build queue.
    await Promise.race(Array.from(state.pending.values(), pending => pending.promise));
    return readSearchData(state, filePath);
  }

  const pending: PendingSearch = { revision, cacheable: true, promise: undefined as never };
  state.pending.set(filePath, pending);
  pending.promise = buildSearchData(state, filePath, pending).finally(() => {
    if (state.pending.get(filePath) === pending) state.pending.delete(filePath);
  });
  return pending.promise;
}

/** One bounded index for the active agent directory, surviving route hot reloads. */
export function getSessionSearchIndex(sessionPaths: readonly string[]): { read(filePath: string): Promise<PreparedSessionSearch | null> } {
  const agentDir = resolve(getAgentDir());
  let state = globalThis.__piSessionSearchIndex;
  if (!state || state.agentDir !== agentDir) {
    if (state) {
      state.active = false;
      state.entries.clear();
      state.bytes = 0;
    }
    state = { agentDir, active: true, entries: new Map(), pending: new Map(), bytes: 0 };
    globalThis.__piSessionSearchIndex = state;
  }

  // Use the authoritative listing on every request, including migration changes
  // published without touching JSONL. Do not retain the full archive's path list.
  const livePaths = new Set(sessionPaths);
  for (const filePath of state.entries.keys()) {
    if (!livePaths.has(filePath)) evict(state, filePath);
  }
  for (const [filePath, pending] of state.pending) {
    pending.cacheable = livePaths.has(filePath);
  }
  const current = state;
  return { read: filePath => readSearchData(current, filePath) };
}
