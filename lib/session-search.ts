import { getAssistantFailure } from "./assistant-outcome";

export interface SessionSearchMatch {
  entryId: string;
  role: "user" | "assistant";
  text: string;
  line: number;
}

interface SearchableEntry {
  type?: unknown;
  id?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
  };
  provider?: unknown;
  modelId?: unknown;
}

export type SessionSearchStatus = "completed" | "failed" | "interrupted" | "unknown";

export interface SessionSearchMetadata {
  provider?: string;
  modelId?: string;
  status: SessionSearchStatus;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join(" ");
}

interface SearchableMessage extends SessionSearchMatch {
  normalizedText?: string;
}

/** Compact search data excludes tool payloads, images and provider-private fields. */
export interface PreparedSessionSearch {
  readonly messages: readonly Readonly<SearchableMessage>[];
  readonly metadata: Readonly<SessionSearchMetadata>;
  /** Conservative retained-string/object estimate, used by the bounded server cache. */
  readonly byteSize: number;
}

function* searchableMessages(entries: readonly SearchableEntry[]): Generator<SearchableMessage> {
  for (let line = 0; line < entries.length; line++) {
    const entry = entries[line];
    if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    yield { entryId: entry.id, role, text: messageText(entry.message.content), line };
  }
}

function searchMessages(messages: Iterable<SearchableMessage>, query: string, limit: number): SessionSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !(limit > 0)) return [];

  const matches: SessionSearchMatch[] = [];
  for (const message of messages) {
    const index = (message.normalizedText ?? message.text.toLowerCase()).indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 40);
    const end = Math.min(message.text.length, index + needle.length + 60);
    matches.push({
      entryId: message.entryId,
      role: message.role,
      text: `${start > 0 ? "…" : ""}${message.text.slice(start, end)}${end < message.text.length ? "…" : ""}`,
      line: message.line,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Pure search over already-parsed entries; never opens or rewrites a session. */
export function searchSessionEntries(
  entries: readonly SearchableEntry[],
  query: string,
  limit = 8,
): SessionSearchMatch[] {
  return searchMessages(searchableMessages(entries), query, limit);
}

/** Extract and normalize once per file revision, retaining all branches. */
export function prepareSessionSearch(entries: readonly SearchableEntry[]): PreparedSessionSearch {
  const metadata = Object.freeze(getSessionSearchMetadata(entries));
  const messages = Object.freeze(Array.from(searchableMessages(entries), message => Object.freeze({
    ...message,
    normalizedText: message.text.toLowerCase(),
  })));
  const byteSize = 256 + 2 * ((metadata.provider?.length ?? 0) + (metadata.modelId?.length ?? 0))
    + messages.reduce((total, message) => total + 128
      + 2 * (message.entryId.length + message.text.length + message.normalizedText.length), 0);
  return Object.freeze({ messages, metadata, byteSize });
}

export function searchPreparedSession(
  prepared: PreparedSessionSearch,
  query: string,
  limit = 8,
): SessionSearchMatch[] {
  return searchMessages(prepared.messages, query, limit);
}

/** Derive filterable model/outcome metadata from the immutable session log. */
export function getSessionSearchMetadata(entries: readonly SearchableEntry[]): SessionSearchMetadata {
  let provider: string | undefined;
  let modelId: string | undefined;
  let status: SessionSearchStatus = "unknown";
  for (const entry of entries) {
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string") provider = entry.provider;
      if (typeof entry.modelId === "string") modelId = entry.modelId;
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const stopReason = entry.message.stopReason;
    status = getAssistantFailure(entry.message) ? "failed" : stopReason === "aborted" ? "interrupted" : "completed";
  }
  return { provider, modelId, status };
}

function textMatchScore(value: string | undefined, query: string, base: number): number {
  const normalized = value?.trim().toLocaleLowerCase() ?? "";
  if (!normalized || !normalized.includes(query)) return 0;
  if (normalized === query) return base + 40;
  if (normalized.startsWith(query)) return base + 20;
  return base;
}

/** Stable relevance score: title > opening prompt > body matches > recency. */
export function scoreSessionSearchHit({
  name,
  firstMessage,
  query,
  matchCount,
  modified,
  now = Date.now(),
}: {
  name?: string;
  firstMessage: string;
  query: string;
  matchCount: number;
  modified: string;
  now?: number;
}): number {
  const needle = query.trim().toLocaleLowerCase();
  const ageDays = Math.max(0, (now - new Date(modified).getTime()) / 86_400_000);
  const recency = Math.max(0, 20 - Math.floor(ageDays));
  return textMatchScore(name, needle, 120)
    + textMatchScore(firstMessage, needle, 80)
    + Math.min(60, matchCount * 10)
    + recency;
}
