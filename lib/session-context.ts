import { buildContextEntries, buildSessionContext as piBuildSessionContext, sessionEntryToContextMessages, type SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, SessionContext, SessionEntry } from "./types";
import { normalizeToolCalls } from "./normalize";

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
