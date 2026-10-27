import { getAssistantFailure } from "@/lib/assistant-outcome";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import type { ConversationLayout } from "./conversation-turns";

export type FindScope = "all" | "user" | "assistant" | "tools" | "errors";

/** Plain text is cached per immutable committed message, not per search keystroke. */
const textCache = new WeakMap<AgentMessage, string>();
export function messageText(message: AgentMessage): string {
  const cached = textCache.get(message);
  if (cached !== undefined) return cached;
  const content = (message as { content?: unknown }).content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? (content as Array<{ text?: string; thinking?: string }>).map(block => block.text ?? block.thinking ?? "").join(" ")
    : "";
  textCache.set(message, text);
  return text;
}

export interface SearchRow {
  role: AgentMessage["role"];
  text: string;
  activity: string;
  all: string;
  hasError: boolean;
}

// Build only while find is open. Tool arguments/results can be large, so do
// this once per committed history change, never per query or streaming token.
export function buildTranscriptSearchIndex(
  messages: AgentMessage[], layout: ConversationLayout, results: Map<string, ToolResultMessage>,
): SearchRow[] {
  return layout.displayIndices.map(index => {
    const message = messages[index];
    const activityMessages = layout.activityByOwner.get(index) ?? [];
    const parts: string[] = [];
    let hasError = getAssistantFailure(message) !== null;
    for (const item of activityMessages) {
      hasError ||= getAssistantFailure(item) !== null;
      if (item.errorMessage) parts.push(item.errorMessage);
      for (const block of item.content) {
        if (block.type === "thinking") parts.push(block.thinking);
        if (block.type === "toolCall") {
          parts.push(block.toolName, JSON.stringify(block.input));
          const result = results.get(block.toolCallId);
          if (result) { parts.push(messageText(result)); hasError ||= !!result.isError; }
        }
      }
    }
    const text = messageText(message).toLowerCase();
    const activity = parts.join(" ").toLowerCase();
    return { role: message.role, text, activity, all: `${text} ${activity}`, hasError };
  });
}

export function findTranscriptMatches(rows: SearchRow[], query: string, scope: FindScope): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: number[] = [];
  rows.forEach((row, index) => {
    if (scope === "user" || scope === "assistant") {
      if (row.role === scope && row.text.includes(needle)) matches.push(index);
    } else if (scope === "tools") {
      if (row.activity.includes(needle)) matches.push(index);
    } else if ((scope !== "errors" || row.hasError) && row.all.includes(needle)) matches.push(index);
  });
  return matches;
}
