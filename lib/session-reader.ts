import { readSessionHeader } from "./session-header";
import { assistantFailure } from "./session-error-summary";
export { readSessionHeader } from "./session-header";
import { migrationDirectory, migrationKey, resolveMigratedSessionId } from "./session-migrations";
import { getAgentDir, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader, SessionInfo, SessionTreeNode } from "./types";
import { readFileSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";

export { getAgentDir };

export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

// ============================================================================
// Incremental session listing
//
// pi's SessionManager.listAll() re-reads every line of every .jsonl file on
// each call. The sidebar refreshes after every agent turn, and the file API
// consults the session list for allowed-roots checks, so with hundreds of
// sessions that becomes a full-disk rescan per request. Instead we stat each
// file and only re-parse the ones whose mtime/size changed; unchanged files
// are served from this cache. Stored on globalThis to survive hot-reload.
// ============================================================================

interface RawSessionInfo {
  path: string;
  id: string;
  sourceSessionId?: string;
  cwd: string;
  name?: string;
  created: string;
  modifiedMs: number;
  messageCount: number;
  firstMessage: string;
  lastMessage: string;
  lastMessageId?: string;
  parentSessionPath?: string;
  lastAssistantError: SessionInfo["lastAssistantError"];
}

interface SessionInfoCacheEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  // null = file exists but is not a valid session (skip without re-parsing)
  info: RawSessionInfo | null;
}

declare global {
  var __piSessionInfoCache: Map<string, SessionInfoCacheEntry> | undefined;
  var __piSessionListings: Map<string, Promise<SessionInfo[]>> | undefined;
}

function getInfoCache(): Map<string, SessionInfoCacheEntry> {
  if (!globalThis.__piSessionInfoCache) globalThis.__piSessionInfoCache = new Map();
  return globalThis.__piSessionInfoCache;
}

async function listingMigrationResolver(): Promise<(id: string) => string> {
  let receipts: Set<string>;
  try {
    receipts = new Set((await readdir(migrationDirectory())).filter(file => file.endsWith(".json")));
  } catch (error) {
    // No directory means no published aliases. Other failures preserve the
    // existing per-receipt lookup rather than assuming an unreadable index is empty.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? id => id : resolveMigratedSessionId;
  }
  if (!receipts.size) return id => id;
  const resolved = new Map<string, string>();
  return id => {
    if (!receipts.has(`${migrationKey(id)}.json`)) return id;
    let target = resolved.get(id);
    if (target === undefined) {
      target = resolveMigratedSessionId(id);
      resolved.set(id, target);
    }
    return target;
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

// Mirrors the fields pi's buildSessionInfo() derives. Reads the file directly
// and parses with pi's parseSessionEntries — deliberately NOT SessionManager.open,
// which rewrites empty/corrupted files as a side effect.
async function parseSessionFile(filePath: string, mtimeMs: number): Promise<RawSessionInfo | null> {
  let entries: Array<Record<string, unknown>>;
  try {
    const content = await readFile(filePath, "utf8");
    entries = parseSessionEntries(content) as unknown as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
  const first = entries[0];
  if (!first || first.type !== "session" || typeof first.id !== "string") return null;
  const header = first as unknown as { id: string; timestamp?: string; cwd?: string; parentSession?: string; sourceSessionId?: string };

  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastMessage = "";
  let lastActivity = 0;
  let lastMessageId: string | undefined;
  let lastAssistantError: SessionInfo["lastAssistantError"] = null;

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "session_info") {
      // Latest session_info wins, including explicit clears
      name = (entry as { name?: string }).name?.trim() || undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown; timestamp?: unknown } | undefined;
    if (message?.role === "system") continue;
    if (message?.role === "assistant") lastAssistantError = assistantFailure(message, typeof entry.timestamp === "string" ? entry.timestamp : undefined);
    messageCount++;
    if (!message || message.content == null) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    lastMessageId = typeof entry.id === "string" ? entry.id : undefined;
    const activity = typeof message.timestamp === "number"
      ? message.timestamp
      : new Date(entry.timestamp as string).getTime();
    if (!Number.isNaN(activity)) lastActivity = Math.max(lastActivity, activity);
    const messageText = extractText(message.content).trim();
    const readableText = messageText.replace(/\s+/g, " ");
    if (!firstMessage && message.role === "user") {
      firstMessage = readableText;
    }
    // Keep Markdown line boundaries until the UI creates its plain excerpt.
    if (readableText) lastMessage = messageText;
  }

  const headerTime = header.timestamp ? new Date(header.timestamp).getTime() : NaN;
  return {
    path: filePath,
    id: header.id,
    sourceSessionId: header.sourceSessionId,
    cwd: header.cwd ?? "",
    name,
    created: new Date(Number.isNaN(headerTime) ? mtimeMs : headerTime).toISOString(),
    modifiedMs: lastActivity > 0 ? lastActivity : Number.isNaN(headerTime) ? mtimeMs : headerTime,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    lastMessage,
    lastMessageId,
    parentSessionPath: header.parentSession,
    lastAssistantError,
  };
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const sessionsDir = getSessionsDir();
  const listings: Map<string, Promise<SessionInfo[]>> = globalThis.__piSessionListings ??= new Map();
  let pending = listings.get(sessionsDir);
  if (!pending) {
    pending = scanAllSessions(sessionsDir);
    listings.set(sessionsDir, pending);
  }
  try {
    // Concurrent sidebar/security requests share disk work, but not mutable results.
    return (await pending).map(info => ({ ...info }));
  } finally {
    if (listings.get(sessionsDir) === pending) listings.delete(sessionsDir);
  }
}

async function scanAllSessions(sessionsDir: string): Promise<SessionInfo[]> {
  const cache = getInfoCache();

  let topLevel;
  try {
    topLevel = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const d of topLevel) {
    if (!d.isDirectory()) continue;
    const dir = join(sessionsDir, d.name);
    try {
      for (const f of await readdir(dir)) {
        if (f.endsWith(".jsonl")) files.push(join(dir, f));
      }
    } catch {
      // unreadable cwd dir — skip
    }
  }

  const seen = new Set<string>();
  const infos: RawSessionInfo[] = [];
  // Bound open files and parsed transcripts even on a cold index with thousands
  // of sessions. A sidebar refresh must not enqueue the entire archive at once.
  let nextFile = 0;
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, async () => {
    while (nextFile < files.length) {
      const filePath = files[nextFile++];
      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue; // deleted between readdir and stat
      }
      seen.add(filePath);
      const cached = cache.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size && cached.ino === st.ino) {
        if (cached.info) infos.push(cached.info);
        continue;
      }
      const info = await parseSessionFile(filePath, st.mtimeMs);
      cache.set(filePath, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, info });
      if (info) infos.push(info);
    }
  }));

  // Evict cache entries for files that no longer exist
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key);
  }

  infos.sort((a, b) => b.modifiedMs - a.modifiedMs);

  const pathToId = new Map<string, string>();
  for (const info of infos) pathToId.set(info.path, info.id);

  const pathCache = getPathCache();
  const legacy = infos.map((info) => {
    // Populate path cache so resolveSessionPath works without a full scan
    pathCache.set(info.id, info.path);
    return {
      path: info.path,
      id: info.id,
      sourceSessionId: info.sourceSessionId,
      cwd: info.cwd,
      name: info.name,
      created: info.created,
      modified: new Date(info.modifiedMs).toISOString(),
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
      lastMessage: info.lastMessage,
      lastMessageId: info.lastMessageId,
      lastAssistantError: info.lastAssistantError,
      parentSessionId: info.parentSessionPath ? pathToId.get(info.parentSessionPath) : undefined,
    };
  });
  // Re-enumerate on every scan: migrations can be published without changing a
  // JSONL file. Avoid thousands of synchronous missing-receipt reads in archives
  // that have few or no migrations, while retaining authoritative receipt validation.
  const resolveMigration = await listingMigrationResolver();
  return legacy.filter(info => resolveMigration(info.id) === info.id).map(info => ({ ...info, parentSessionId: info.parentSessionId ? resolveMigration(info.parentSessionId) : undefined })).sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) {
    try {
      const cachedStat = await stat(cached);
      if (cachedStat.isFile()) return cached;
    } catch {
      // Pi assigns the future path of a new session before it writes the file.
      // Do not let that stale cache entry revive an empty phantom session after
      // the live runtime switches away.
    }
    getPathCache().delete(sessionId);
  }

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
}

export function readSessionFile(filePath: string): { header: SessionHeader | null; entries: SessionEntry[] } {
  const parsed = parseSessionEntries(readFileSync(filePath, "utf8")) as unknown as Array<SessionHeader | SessionEntry>;
  // Pi's migrations mutate the parsed objects. Running them on this in-memory
  // array keeps legacy sessions readable without rewriting the user's JSONL.
  migrateSessionEntries(parsed as never);
  return {
    header: (parsed.find((entry) => entry.type === "session") as SessionHeader | undefined) ?? null,
    entries: parsed.filter((entry): entry is SessionEntry => entry.type !== "session"),
  };
}

/** Read only the immutable first-line session header without opening or rewriting the file. */
export function readSessionCwd(filePath: string): string | null {
  return readSessionHeader(filePath)?.cwd ?? null;
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  return readSessionFile(filePath).entries;
}

export function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const labelsById = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "label") {
      const l = entry as { type: "label"; targetId: string; label?: string };
      if (l.label) labelsById.set(l.targetId, l.label);
      else labelsById.delete(l.targetId);
    }
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [], label: labelsById.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    if (!entry.parentId) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
    stack.push(...node.children);
  }
  return roots;
}

export { buildSessionContext } from "./session-context";

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}
