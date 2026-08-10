import { buildSessionContext as piBuildSessionContext, getAgentDir, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader, SessionInfo, SessionContext, SessionTreeNode, AssistantMessage } from "./types";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
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
  cwd: string;
  name?: string;
  created: string;
  modifiedMs: number;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
}

interface SessionInfoCacheEntry {
  mtimeMs: number;
  size: number;
  // null = file exists but is not a valid session (skip without re-parsing)
  info: RawSessionInfo | null;
}

declare global {
  var __piSessionInfoCache: Map<string, SessionInfoCacheEntry> | undefined;
}

function getInfoCache(): Map<string, SessionInfoCacheEntry> {
  if (!globalThis.__piSessionInfoCache) globalThis.__piSessionInfoCache = new Map();
  return globalThis.__piSessionInfoCache;
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
  const header = first as unknown as { id: string; timestamp?: string; cwd?: string; parentSession?: string };

  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastActivity = 0;

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "session_info") {
      // Latest session_info wins, including explicit clears
      name = (entry as { name?: string }).name?.trim() || undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount++;
    const message = entry.message as { role?: string; content?: unknown; timestamp?: unknown } | undefined;
    if (!message || message.content == null) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const activity = typeof message.timestamp === "number"
      ? message.timestamp
      : new Date(entry.timestamp as string).getTime();
    if (!Number.isNaN(activity)) lastActivity = Math.max(lastActivity, activity);
    if (!firstMessage && message.role === "user") {
      firstMessage = extractText(message.content);
    }
  }

  const headerTime = header.timestamp ? new Date(header.timestamp).getTime() : NaN;
  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    name,
    created: new Date(Number.isNaN(headerTime) ? mtimeMs : headerTime).toISOString(),
    modifiedMs: lastActivity > 0 ? lastActivity : Number.isNaN(headerTime) ? mtimeMs : headerTime,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    parentSessionPath: header.parentSession,
  };
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const sessionsDir = getSessionsDir();
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
  await Promise.all(files.map(async (filePath) => {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return; // deleted between readdir and stat
    }
    seen.add(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      if (cached.info) infos.push(cached.info);
      return;
    }
    const info = await parseSessionFile(filePath, st.mtimeMs);
    cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, info });
    if (info) infos.push(info);
  }));

  // Evict cache entries for files that no longer exist
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key);
  }

  infos.sort((a, b) => b.modifiedMs - a.modifiedMs);

  const pathToId = new Map<string, string>();
  for (const info of infos) pathToId.set(info.path, info.id);

  const pathCache = getPathCache();
  return infos.map((info) => {
    // Populate path cache so resolveSessionPath works without a full scan
    pathCache.set(info.id, info.path);
    return {
      path: info.path,
      id: info.id,
      cwd: info.cwd,
      name: info.name,
      created: info.created,
      modified: new Date(info.modifiedMs).toISOString(),
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
      parentSessionId: info.parentSessionPath ? pathToId.get(info.parentSessionPath) : undefined,
    };
  });
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
  try {
    const firstLine = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
    const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null;
  }
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

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Find the last compaction on path (mirrors pi's buildSessionContext logic)
  let compactionId: string | undefined;
  let firstKeptEntryId: string | undefined;
  for (const e of path) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = (e as { firstKeptEntryId: string }).firstKeptEntryId;
    }
  }

  const entryIds: string[] = [];
  const contributesMessage = (entry: SessionEntry) =>
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
  if (compactionId) {
    // The first message in piCtx.messages is the synthetic compaction summary — map to compaction entry id
    entryIds.push(compactionId);
    const compactionIdx = path.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? path.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (contributesMessage(path[i])) entryIds.push(path[i].id);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (contributesMessage(path[i])) entryIds.push(path[i].id);
    }
  } else {
    for (const e of path) {
      if (contributesMessage(e)) entryIds.push(e.id);
    }
  }

  // pi injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const messages = (piCtx.messages as AssistantMessage[]).map((msg) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return {
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      };
    }
    return normalizeToolCalls(msg);
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}
