import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defineDoc, type AgentState, type EntryRecord } from "@earendil-works/pi-durable";
import type { AgentMessage, SessionContext, SessionEntry, SessionInfo, SessionTreeNode } from "./types";
import { normalizeToolCalls } from "./normalize";
import { LEGACY_CONTEXT, legacyArchive, legacyBoundary, legacyContext, type LegacyArchive } from "./durable-legacy";
import { resolveMigratedSessionId } from "./session-migrations";
import type { AgentRun } from "./agent-run-types";

export const DurableSessionMeta = defineDoc({
  kind: "pi-web.session", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ name: "", created: "", parentSessionId: "", deleted: false as boolean, sourceSessionId: "" }),
});

export interface DurableSessionProjection {
  version: 1;
  info: SessionInfo;
  deleted: boolean;
  entries: EntryRecord[];
  agent: AgentState;
  context: SessionContext;
  agentRun?: AgentRun;
}

export function durableSessionIdentity(id: string): { group: string; conversation: number } | undefined {
  const match = /^dw_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([1-9][0-9]*)$/i.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { group: match[1], conversation: Number(match[2]) };
}
export const isDurableSessionId = (id: string): boolean => durableSessionIdentity(id) !== undefined;
export const durableSessionId = (group: string, conversation: number): string => `dw_${group}_${conversation}`;
export const durableSessionsDirectory = (): string => join(getAgentDir(), "durable-sessions");
export function durableSessionDirectory(group: string): string {
  if (!durableSessionIdentity(durableSessionId(group, 1))) throw new Error("Invalid Durable store ID");
  return join(durableSessionsDirectory(), group);
}
export function writeDurableJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
export function saveDurableProjection(directory: string, conversation: number, projection: DurableSessionProjection): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeDurableJson(join(directory, `${conversation}.json`), projection);
}
/** Read-only derived index. Opening the sidebar never resumes paid work. */
export function readDurableProjection(id: string): DurableSessionProjection | undefined {
  const identity = durableSessionIdentity(id);
  if (!identity) return undefined;
  try {
    const projection = JSON.parse(readFileSync(join(durableSessionDirectory(identity.group), `${identity.conversation}.json`), "utf8")) as DurableSessionProjection;
    return projection.version === 1 && projection.info.id === id && !projection.deleted
      && (!projection.info.sourceSessionId || resolveMigratedSessionId(projection.info.sourceSessionId) === id) ? projection : undefined;
  } catch { return undefined; }
}
export function listDurableSessions(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  try {
    for (const group of readdirSync(durableSessionsDirectory())) {
      if (!durableSessionIdentity(durableSessionId(group, 1))) continue;
      try {
        for (const file of readdirSync(durableSessionDirectory(group))) {
          if (!/^[1-9][0-9]*\.json$/.test(file)) continue;
          const projection = readDurableProjection(durableSessionId(group, Number(file.slice(0, -5))));
          if (projection && (!projection.info.sourceSessionId || resolveMigratedSessionId(projection.info.sourceSessionId) === projection.info.id)) sessions.push(projection.info);
        }
      } catch { /* A concurrently removed or inaccessible store is omitted. */ }
    }
  } catch { /* First Durable session has not been created. */ }
  return sessions;
}
export function listDurableChildRuns(): AgentRun[] {
  return listDurableSessions().flatMap(info => { const run = readDurableProjection(info.id)?.agentRun; return run ? [run] : []; });
}

export function durableMessage(message: NonNullable<EntryRecord["model"]>[number]): AgentMessage | undefined {
  if (message.role === "system") return undefined;
  const content = Array.isArray(message.content) ? message.content.map(block => block.type === "image"
    ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } } : block) : message.content;
  return normalizeToolCalls({ ...message, content } as unknown as AgentMessage);
}
export function durableEntries(entries: readonly EntryRecord[], created: string, prefix = legacyArchive(entries) ? "durable:" : ""): SessionEntry[] {
  let parentId: string | null = null;
  return entries.flatMap(entry => {
    const base = { id: `${prefix}${entry.id}`, parentId, timestamp: new Date(entry.model?.[0]?.timestamp ?? Date.parse(created)).toISOString() };
    let result: SessionEntry[];
    if (entry.kind === LEGACY_CONTEXT) {
      const archive = entry.data as unknown as LegacyArchive;
      result = [...archive.entries, legacyBoundary(entry, archive)] as unknown as SessionEntry[];
    } else if (entry.kind === "pi-web.extension-message") {
      const data = entry.data as unknown as Extract<SessionEntry, { type: "custom_message" }>;
      result = [{ ...base, type: "custom_message", customType: data.customType, content: data.content, display: data.display, details: data.details }];
    } else if (entry.kind === "pi-web.extension-entry") {
      const data = entry.data as { customType: string; data?: unknown };
      result = [{ ...base, type: "custom", customType: data.customType, data: data.data }];
    } else if (entry.kind === "pi-web.shell") {
      const data = entry.data as { command: string; output: string; timestamp: number };
      result = [{ ...base, timestamp: new Date(data.timestamp).toISOString(), type: "message", message: { role: "bashExecution", ...data } }];
    } else if (entry.kind === "pi.compaction") {
      const summary = entry.model?.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.filter(block => block.type === "text").map(block => block.text)).join("\n") ?? "";
      result = [{ ...base, type: "compaction", summary, firstKeptEntryId: `${prefix}${entry.head ?? entry.id}`, tokensBefore: 0 }];
    } else {
      result = [];
      for (const [index, raw] of (entry.model ?? []).entries()) {
        const message = durableMessage(raw);
        if (!message) continue;
        const id = index === 0 ? base.id : `${base.id}:${index}`;
        result.push({ type: "message", id, parentId, timestamp: "timestamp" in raw ? new Date(raw.timestamp).toISOString() : created, message });
        parentId = id;
      }
    }
    if (result.length) parentId = result.at(-1)!.id;
    return result;
  });
}
export function durableContext(entries: readonly EntryRecord[], agent: AgentState, at?: string): SessionContext {
  const archive = legacyArchive(entries);
  if (at && archive?.entries.some(entry => entry.id === at)) return legacyContext(archive, at);
  const prefix = archive ? "durable:" : "";
  const [target, targetIndex = "0"] = at?.replace(/^durable:/, "").split(":") ?? [];
  const visible = at ? entries.filter(entry => entry.id <= Number(target)) : entries;
  const marker = visible.findLast(entry => entry.head !== undefined);
  const active = marker ? [marker, ...visible.filter(entry => entry.id >= marker.head! && entry.head === undefined)] : visible;
  const edits = new Map(active.flatMap(entry => (entry.edits ?? []).map(edit => [edit.target, edit] as const)));
  const projected = active.flatMap(entry => {
    const edit = edits.get(entry.id);
    if (edit?.action === "omit") return [];
    const value = edit ? { ...entry, model: edit.messages } : entry;
    if (value.kind === LEGACY_CONTEXT) {
      const saved = legacyContext(value.data as unknown as LegacyArchive);
      return saved.messages.map((message, i): SessionEntry => ({ type: "message", id: saved.entryIds[i], parentId: null, timestamp: "1970-01-01T00:00:00.000Z", message }));
    }
    return durableEntries([value], "1970-01-01T00:00:00.000Z", prefix);
  });
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of projected) {
    const nativeId = entry.id.replace(/^durable:/, "").split(":");
    if (at && nativeId[0] === target && Number(nativeId[1] ?? 0) > Number(targetIndex)) continue;
    const message: AgentMessage | undefined = entry.type === "message" ? entry.message
      : entry.type === "custom_message" ? { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) }
      : entry.type === "compaction" ? { role: "user", content: `*The conversation history before this point was compacted into the following summary:*\n\n${entry.summary}`, timestamp: Date.parse(entry.timestamp) }
      : undefined;
    if (message) { messages.push(message); entryIds.push(entry.id); }
  }
  return { messages, entryIds, thinkingLevel: agent.thinkingLevel ?? "off", model: agent.model ?? null };
}
export function durableSessionData(projection: DurableSessionProjection) {
  // Every conversation has an immutable ancestry; forks get their own session ID.
  const entries = durableEntries(projection.entries, projection.info.created);
  const tree: SessionTreeNode[] = [];
  const nodes = new Map(entries.map(entry => [entry.id, { entry, children: [] } as SessionTreeNode]));
  for (const node of nodes.values()) {
    const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
    (parent?.children ?? tree).push(node);
    if (node.entry.type === "label") { const target = nodes.get(node.entry.targetId); if (target) target.label = node.entry.label; }
  }
  return { sessionId: projection.info.id, filePath: projection.info.path, info: projection.info,
    tree, leafId: entries.at(-1)?.id ?? null, context: projection.context };
}
