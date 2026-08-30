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

/** Pure search over already-parsed entries; never opens or rewrites a session. */
export function searchSessionEntries(
  entries: readonly SearchableEntry[],
  query: string,
  limit = 8,
): SessionSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle || limit <= 0) return [];

  const matches: SessionSearchMatch[] = [];
  for (let line = 0; line < entries.length && matches.length < limit; line++) {
    const entry = entries[line];
    if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(entry.message.content);
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;

    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + needle.length + 60);
    matches.push({
      entryId: entry.id,
      role,
      text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
      line,
    });
  }
  return matches;
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
    status = stopReason === "error" ? "failed" : stopReason === "aborted" ? "interrupted" : "completed";
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
