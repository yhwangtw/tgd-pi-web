/** Provider-independent outcomes, shared by runtime snapshots and chat UI. */
export type AssistantOutputIssue = "output_limit" | "empty_output";
interface OutcomeMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

export function hasVisibleAssistantAnswer(value: unknown): boolean {
  const message = value as OutcomeMessage | null | undefined;
  if (message?.role !== "assistant") return false;
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return Array.isArray(message.content) && message.content.some(block => block?.type === "image"
    || (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0));
}

export function getAssistantOutputIssue(value: unknown): AssistantOutputIssue | null {
  const message = value as OutcomeMessage | null | undefined;
  if (message?.role !== "assistant") return null;
  if (message.stopReason === "length") return "output_limit";
  // Only a known, finished response is empty. Streaming placeholders, unknown
  // legacy payloads and tool handoffs are not evidence of a missing answer.
  if (message.stopReason !== "stop" || message.content === undefined || hasVisibleAssistantAnswer(message)) return null;
  if (Array.isArray(message.content) && !message.content.some(block => block?.type === "toolCall")) return "empty_output";
  return typeof message.content === "string" ? "empty_output" : null;
}

export function getAssistantFailure(value: unknown): string | null {
  const message = value as OutcomeMessage | null | undefined;
  if (message?.role !== "assistant") return null;
  if (message.stopReason === "error") return typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : "Model call failed";
  const issue = getAssistantOutputIssue(message);
  if (issue === "output_limit") return "Output token limit reached";
  if (issue === "empty_output") return "Model finished without a visible answer";
  return null;
}
