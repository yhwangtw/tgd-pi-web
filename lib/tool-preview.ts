import type { AgentMessage, ToolCallContent } from "./types";
import type { AgentPhase } from "./agent-run-state";

export function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const tasks = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : null;
  if (tasks) {
    const agents = [...new Set(tasks.flatMap(item => item && typeof item === "object" && "agent" in item ? [String(item.agent)] : []))];
    return `${tasks.length} ${Array.isArray(input.chain) ? "steps" : "tasks"}${agents.length ? ` · ${agents.join(", ")}` : ""}`.slice(0, 120);
  }
  const keys = Object.keys(input);
  if (!keys.length) return "";
  const key = ["command", "path", "file_path", "pattern", "query", "objective", "title", "task"].find(key => key in input) ?? keys[0];
  const value = input[key];
  if (value == null) return key;
  const text = typeof value === "object" ? `${key}: ${JSON.stringify(value)}` : String(value);
  return text.length > 120 ? text.slice(0, 119) + "…" : text;
}

/** Full readable target for the opt-in activity disclosure. */
export function getToolTarget(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const key = ["command", "path", "file_path", "pattern", "query", "objective", "title", "task"].find(key => key in input);
  return key && typeof input[key] === "string" ? input[key].slice(0, 4000) : getToolPreview(block);
}

export function activeToolDetails(phase: AgentPhase, messages: readonly AgentMessage[], streamingMessage?: Partial<AgentMessage> | null) {
  if (phase?.kind !== "running_tools") return [];
  const calls = new Map<string, ToolCallContent>();
  const activeIds = new Set(phase.tools.map(tool => tool.id));
  for (const message of [streamingMessage, ...messages.slice().reverse()]) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && activeIds.has(block.toolCallId) && !calls.has(block.toolCallId)) calls.set(block.toolCallId, block);
    }
    if (calls.size === activeIds.size) break;
  }
  return phase.tools.map(tool => {
    const call = calls.get(tool.id);
    const matched = call?.toolName === tool.name ? call : undefined;
    return { ...tool, preview: matched ? getToolPreview(matched) : "", target: matched ? getToolTarget(matched) : "", canReveal: !!matched };
  });
}

/** Look up only the current runtime's active call, never a guessed last tool. */
export function activeToolPreview(phase: AgentPhase, messages: readonly AgentMessage[], streamingMessage?: Partial<AgentMessage> | null): string {
  if (phase?.kind !== "running_tools" || !phase.tools.length) return "";
  const first = phase.tools[0];
  const preview = (message?: Partial<AgentMessage> | null) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const call = message.content.find(block => block.type === "toolCall" && block.toolCallId === first.id && block.toolName === first.name);
    return call?.type === "toolCall" ? getToolPreview(call) : undefined;
  };
  const current = preview(streamingMessage);
  if (current !== undefined) return current;
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = preview(messages[i]);
    if (found !== undefined) return found;
  }
  return "";
}
