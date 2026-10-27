import type { AgentMessage } from "./types";

export const COMPACTION_MESSAGE_TYPE = "pi-web-compaction";
const LEGACY_PREFIX = "*The conversation history before this point was compacted into the following summary:*";

/** Recognize typed transcript notes and summaries returned by older servers. */
export function getCompactionSummary(message: AgentMessage): string | null {
  if (message.role === "custom" && message.customType === COMPACTION_MESSAGE_TYPE && message.display) {
    return typeof message.content === "string" ? message.content : null;
  }
  if (message.role !== "user" || typeof message.content !== "string" || !message.content.startsWith(LEGACY_PREFIX)) return null;
  return message.content.slice(LEGACY_PREFIX.length).trim();
}
