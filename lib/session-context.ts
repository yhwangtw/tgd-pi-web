import { buildContextEntries, buildSessionContext as piBuildSessionContext, sessionEntryToContextMessages, type SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, SessionContext, SessionEntry } from "./types";
import { normalizeToolCalls } from "./normalize";
import { COMPACTION_MESSAGE_TYPE } from "./compaction-message";
import { readGenerationMetrics } from "./server-generation-metrics";

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

/** Human-readable history on the selected branch, independent of model compaction.
 * The wire field is still named `context` for existing Web clients; never feed
 * this transcript back into the agent. Pi owns its compacted model context.
 */
export function buildSessionTranscript(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = leafId === null ? undefined : (leafId ? byId.get(leafId) : undefined) ?? entries.at(-1);
  while (current) {
    if (seen.has(current.id)) throw new Error("Invalid session branch: cyclic parent reference");
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  const settings = piBuildSessionContext(entries as unknown as PiSessionEntry[], leafId, byId as unknown as Map<string, PiSessionEntry>);
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of path) {
    if (entry.type === "compaction") {
      messages.push({ role: "custom", customType: COMPACTION_MESSAGE_TYPE, display: true,
        content: entry.summary ?? "", timestamp: Date.parse(entry.timestamp) });
      entryIds.push(entry.id);
      continue;
    }
    for (const message of sessionEntryToContextMessages(entry as unknown as PiSessionEntry)) {
      if (message.role === "system") continue;
      // Hidden extension instructions are model context, never chat history.
      if (message.role === "custom" && !message.display) continue;
      messages.push(normalizeToolCalls(message as AgentMessage));
      entryIds.push(entry.id);
    }
  }
  const generationMetrics = readGenerationMetrics(path);
  return { messages, entryIds, thinkingLevel: settings.thinkingLevel, model: settings.model,
    ...(Object.keys(generationMetrics).length ? { generationMetrics } : {}),
  };
}
