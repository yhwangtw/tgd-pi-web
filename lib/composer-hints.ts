import type { AgentMessage } from "./types";

export interface ComposerHintMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ComposerHintRequest {
  provider: string;
  modelId: string;
  locale: "en" | "zh";
  messages: ComposerHintMessage[];
}

export const MAX_HINT_CHARS = 160;
export const MAX_HINT_CONTEXT_CHARS = 3000;

/** Only visible text from the latest exchange; never images, thinking or tools. */
export function composerHintMessages(messages: AgentMessage[]): ComposerHintMessage[] | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted"
    || last.content.some(block => block.type === "toolCall")
    || !last.content.some(block => block.type === "text" && block.text.trim())) return null;
  const result: ComposerHintMessage[] = [];
  let remaining = MAX_HINT_CONTEXT_CHARS;
  for (let i = messages.length - 1; i >= 0 && result.length < 4 && remaining > 0; i--) {
    const message = messages[i];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = (typeof message.content === "string" ? message.content
      : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"))
      .trim().slice(-Math.min(remaining, message.role === "user" ? 600 : 1400));
    if (text) { result.unshift({ role: message.role, text }); remaining -= text.length; }
  }
  return result.at(-1)?.role === "assistant" && result.some(message => message.role === "user") ? result : null;
}

export function isComposerHintRequest(value: unknown): value is ComposerHintRequest {
  if (!value || typeof value !== "object") return false;
  const body = value as ComposerHintRequest;
  return typeof body.provider === "string" && body.provider.length > 0 && body.provider.length <= 200
    && typeof body.modelId === "string" && body.modelId.length > 0 && body.modelId.length <= 300
    && (body.locale === "en" || body.locale === "zh")
    && Array.isArray(body.messages) && body.messages.length >= 2 && body.messages.length <= 4
    && body.messages.every(message => message && (message.role === "user" || message.role === "assistant")
      && typeof message.text === "string" && message.text.trim().length > 0)
    && body.messages.reduce((size, message) => size + message.text.length, 0) <= MAX_HINT_CONTEXT_CHARS
    && body.messages.at(-1)?.role === "assistant" && body.messages.some(message => message.role === "user");
}

export function cleanComposerHint(text: string): string | null {
  const hint = text.trim().replace(/^["'“”`]+|["'“”`]+$/g, "").trim();
  if (!hint || hint.length > MAX_HINT_CHARS || /[\r\n\x00-\x1f]/.test(hint)
    || /^(?:NONE|null|undefined)$/i.test(hint) || /^[\/<{\[]/.test(hint)) return null;
  return hint;
}
