import { buildContextEntries, buildSessionContext as piBuildSessionContext, getAgentDir, migrateSessionEntries, parseSessionEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader, SessionInfo, SessionContext, SessionTreeNode, AgentMessage } from "./types";
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
  lastMessage: string;
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
  let lastMessage = "";
  let lastActivity = 0;

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
    messageCount++;
    if (!message || message.content == null) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
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
    cwd: header.cwd ?? "",
    name,
    created: new Date(Number.isNaN(headerTime) ? mtimeMs : headerTime).toISOString(),
    modifiedMs: lastActivity > 0 ? lastActivity : Number.isNaN(headerTime) ? mtimeMs : headerTime,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    lastMessage,
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
      lastMessage: info.lastMessage,
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
  const piIndex = byId as unknown as Map<string, PiSessionEntry>;
  const piCtx = piBuildSessionContext(piEntries, leafId, piIndex);
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];

  // Pi 0.86 can project one compaction entry into both system state and a
  // summary. Use its projection for both arrays so fork/edit targets stay
  // aligned after compaction, branching, and hidden system/tool updates.
  for (const entry of buildContextEntries(piEntries, leafId, piIndex)) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role === "system") continue;
      const raw = message as unknown as Record<string, unknown>;
      messages.push(raw.role === "compactionSummary" ? {
        role: "user",
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      } : normalizeToolCalls(message as AgentMessage));
      entryIds.push(entry.id);
    }
  }

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
