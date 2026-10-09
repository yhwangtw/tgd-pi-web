import { buildSessionContext, convertToLlm, migrateSessionEntries, type FileEntry, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import { buildSessionContext as webContext } from "./session-context";
import { emptyWorkflow, readWorkflow, WORKFLOW_ENTRY } from "./workflow-state";

export const LEGACY_CONTEXT = "pi-web.legacy-context";
export interface LegacyArchive {
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
}
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Parse strictly: SDK's forgiving JSONL parser can silently drop corrupt lines. */
export function parseLegacyArchive(source: string, id: string, leafId?: string | null): LegacyArchive {
  const files = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) as FileEntry[];
  const header = files[0];
  if (!header || header.type !== "session" || header.id !== id || !header.cwd || !Number.isFinite(Date.parse(header.timestamp)) || (header.version ?? 1) > 3) throw new Error("Unsupported or incomplete session header");
  migrateSessionEntries(files);
  const entries = files.slice(1) as SessionEntry[];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.startsWith("durable:") || ids.has(entry.id) || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error("Invalid or duplicate history entry");
    if (entry.parentId !== null && !ids.has(entry.parentId)) throw new Error("History has a missing parent or cycle");
    if (!["message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"].includes(entry.type)) throw new Error("Unsupported history entry type");
    if (entry.type === "message" && !["user", "assistant", "toolResult", "bashExecution", "custom", "compactionSummary", "branchSummary", "system"].includes(entry.message?.role)) throw new Error("Unsupported history message type");
    ids.add(entry.id);
  }
  const leaf = leafId === undefined ? entries.at(-1)?.id ?? null : leafId;
  if (leaf !== null && !ids.has(leaf)) throw new Error("Selected branch is missing");
  const archive = { header, entries, leafId: leaf };
  // Every branch must remain readable, even branches outside the active context.
  const parents = new Set(entries.map(entry => entry.parentId));
  for (const entry of entries) if (!parents.has(entry.id)) buildSessionContext(entries, entry.id);
  legacyModel(archive);
  return archive;
}
export function legacyModel(archive: LegacyArchive): NonNullable<EntryRecord["model"]> {
  const model = plain(convertToLlm(buildSessionContext(archive.entries, archive.leafId).messages));
  const pending = new Set<string>();
  for (const message of model) {
    if (message.role === "assistant") {
      if (pending.size) throw new Error("Historical tool calls have no recorded result");
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("Historical tool result has no matching call");
    } else if (message.role === "user" && pending.size) throw new Error("Historical tool calls have no recorded result");
  }
  if (pending.size) throw new Error("Unfinished historical tools cannot be resumed as Durable tasks");
  return model as unknown as NonNullable<EntryRecord["model"]>;
}
export function legacyContext(archive: LegacyArchive, leaf = archive.leafId) {
  return webContext(archive.entries as never, leaf);
}
export function legacySettings(archive: LegacyArchive) {
  const system = getCurrentSystemMessage(buildSessionContext(archive.entries, archive.leafId).messages);
  return system ? { instructions: getSystemMessageText(system), toolNames: (system.toolsAdded ?? []).map(tool => tool.name) } : {};
}
export function legacyWorkflow(archive: LegacyArchive) {
  const index = new Map(archive.entries.map(entry => [entry.id, entry]));
  for (let entry = archive.leafId ? index.get(archive.leafId) : undefined; entry; entry = entry.parentId ? index.get(entry.parentId) : undefined) {
    if (entry.type === "custom" && entry.customType === WORKFLOW_ENTRY) {
      const state = readWorkflow(entry.data);
      if (!state) throw new Error("Saved Goal/Plan state is invalid");
      if (state.goal?.status === "active") { state.goal.status = "paused"; state.goal.reason = "Paused after migration. Resume when ready."; }
      return state;
    }
  }
  return emptyWorkflow();
}
export function legacyArchive(entries: readonly EntryRecord[]): LegacyArchive | undefined {
  return entries.find(entry => entry.kind === LEGACY_CONTEXT)?.data as unknown as LegacyArchive | undefined;
}
export function legacyBoundary(entry: EntryRecord, archive: LegacyArchive): SessionEntry {
  return { type: "custom", customType: "pi-web-migration-boundary", id: `durable:${entry.id}`, parentId: archive.leafId, timestamp: archive.header.timestamp };
}
