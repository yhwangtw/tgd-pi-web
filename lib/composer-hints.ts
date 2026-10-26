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
  /** Local cache identity only; never sent to the model. */
  turnId?: string;
}

export const MAX_HINT_CHARS = 160;
export const MAX_HINT_CONTEXT_CHARS = 3000;
export const HINT_MAX_ATTEMPTS = 3;
export const HINT_RETRY_DELAY_MS = 2000;
export const HINT_FAILURE_COOLDOWN_MS = 60_000;
export const HINT_SUCCESS_TTL_MS = 10 * 60_000;
export const HINT_MODEL_TIMEOUT_MS = 15_000;
export const HINT_FETCH_TIMEOUT_MS = HINT_MODEL_TIMEOUT_MS + 2000;

export interface ComposerHintResult {
  hint: string | null;
  status: "ready" | "empty" | "error" | "unavailable" | "busy";
  retryable: boolean;
  retryAfterMs: number;
}

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
    && (body.turnId === undefined || (typeof body.turnId === "string" && body.turnId.length > 0 && body.turnId.length <= 256))
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
  // A suggestion is a user's request to the assistant, not an assistant's promise.
  // These conservative lead-in checks supplement the model's role instructions.
  if (/^(?:(?:好的|好|沒問題|没问题)[，,！!\s]*)?(?:我(?:會|会|將|将|先|來|来|正在|已|幫你|帮你|可以(?:先|幫|帮))|已(?:完成|修復|修复|更新|加入|處理|处理|解決|解决))/.test(hint)
    || /^(?:(?:sure|okay|ok)[,!.:\s]+)?(?:I(?:['’]ll| will| am going to|['’]m going to| can help)\b|let me\b|I(?:['’]ve| have)\s+(?:fixed|completed|finished|implemented|updated)\b|done(?:[.!:\s]|$))/i.test(hint)) return null;
  return hint;
}
