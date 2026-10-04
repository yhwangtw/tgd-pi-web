import type { AgentMessage, AssistantMessage } from "./types";

export interface GenerationMetrics {
  tokens: number;
  seconds: number;
  estimated: boolean;
}

/** Display estimate only: tokenization varies by model, especially for Unicode. */
export function estimateTextTokens(text: string): number {
  const dense = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/gu)?.length ?? 0;
  return dense + (Array.from(text).length - dense) / 4;
}

export function messageText(message: Partial<AssistantMessage>): string {
  return (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

const messageKeys = new WeakMap<AgentMessage, string>();
function messageKey(message: AgentMessage): string | null {
  if (message.role !== "assistant" || !message.timestamp) return null;
  const cached = messageKeys.get(message);
  if (cached) return cached;
  // Bind a measurement to the actual answer without saving its text.
  let hash = 2166136261;
  for (const char of messageText(message)) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  const key = `${message.provider}:${message.model}:${message.timestamp}:${hash >>> 0}`;
  messageKeys.set(message, key);
  return key;
}

const STORAGE_KEY = "pi-generation-metrics-v1";
const MAX_RECORDS = 500;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
type StoredMetrics = GenerationMetrics & { savedAt: number };
type MetricsStorage = Pick<Storage, "getItem" | "setItem">;

function readMetrics(storage?: MetricsStorage): Map<string, StoredMetrics> {
  try {
    const raw = storage?.getItem(STORAGE_KEY) ?? "[]";
    if (raw.length > 2 * 1024 * 1024) return new Map();
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.filter((entry): entry is [string, StoredMetrics] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0].length > 1024) return false;
      const value = entry[1] as StoredMetrics | null;
      return !!value && Number.isFinite(value.tokens) && value.tokens > 0
        && Number.isFinite(value.seconds) && value.seconds >= 1 && typeof value.estimated === "boolean"
        && Number.isFinite(value.savedAt) && value.savedAt > Date.now() - MAX_AGE_MS && value.savedAt <= Date.now();
    }).slice(-MAX_RECORDS));
  } catch { return new Map(); }
}

export function browserMetricsStorage(): MetricsStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Client-observed full generations only. Replayed/snapshot streams have no timing. */
export class GenerationMetricsTracker {
  private sessionId: string | null = null;
  private live = false;
  private active: { start: number; text: string; updates: number } | null = null;
  private completed: Map<string, StoredMetrics>;
  private views = new Map<string, GenerationMetrics>();

  constructor(private storage?: MetricsStorage) { this.completed = readMetrics(storage); }

  private save(sessionId: string, key: string, metrics: GenerationMetrics) {
    const storedKey = JSON.stringify([sessionId, key]);
    const value = { ...metrics, savedAt: Date.now() };
    // Merge other tabs' completed measurements before a bounded write.
    const merged = readMetrics(this.storage);
    for (const [key, entry] of this.completed) merged.set(key, entry);
    merged.set(storedKey, value);
    this.completed = new Map([...merged].sort((a, b) => a[1].savedAt - b[1].savedAt).slice(-MAX_RECORDS));
    this.views.delete(storedKey);
    for (const key of this.views.keys()) if (!this.completed.has(key)) this.views.delete(key);
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.completed])); } catch { /* memory-only if storage is unavailable/full */ }
  }

  record(sessionId: string | null, event: { type: string; message?: unknown }, now: number): void {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.live = false;
      this.active = null;
    }
    if (event.type === "connected") { this.live = false; this.active = null; return; }
    if (event.type === "session_snapshot") { this.live = true; this.active = null; return; }
    if (!this.live) return;
    if (["agent_end", "auto_retry_start"].includes(event.type)) { this.active = null; return; }
    const message = event.message as AssistantMessage | undefined;
    if (message?.role !== "assistant") return;
    if (event.type === "message_start") {
      // A prefilled start can be replayed or buffered: do not pretend we observed it.
      this.active = messageText(message) ? null : { start: now, text: "", updates: 0 };
    } else if (event.type === "message_update" && this.active) {
      const text = messageText(message);
      if (text !== this.active.text) { this.active.text = text; this.active.updates++; }
    } else if (event.type === "message_end") {
      const active = this.active;
      this.active = null;
      const key = messageKey(message);
      const seconds = active ? (now - active.start) / 1000 : 0;
      if (!active || !key || seconds < 1 || active.updates < 2 || !messageText(message)
        || message.errorMessage || ["error", "aborted"].includes(message.stopReason ?? "")
        || message.content.some((block) => block.type === "toolCall")) return;
      const output = message.usage?.output;
      const estimated = !(typeof output === "number" && Number.isFinite(output) && output > 0);
      const tokens = estimated ? Math.round(estimateTextTokens(messageText(message))) : output!;
      if (tokens > 0 && sessionId) this.save(sessionId, key, { tokens, seconds, estimated });
    }
  }

  get(sessionId: string | null, message: AgentMessage): GenerationMetrics | undefined {
    const key = messageKey(message);
    const storedKey = key && sessionId ? JSON.stringify([sessionId, key]) : "";
    const stored = this.completed.get(storedKey);
    if (!stored) return undefined;
    const existing = this.views.get(storedKey);
    if (existing) return existing;
    const { tokens, seconds, estimated } = stored;
    const value = { tokens, seconds, estimated };
    this.views.set(storedKey, value);
    return value;
  }
}

/** Three-second rolling text delta; an initial buffered frame is only a baseline. */
export class TextRateWindow {
  private samples: Array<{ time: number; tokens: number }> = [];
  private lastChange = 0;

  sample(tokens: number, now: number): number | null {
    const last = this.samples.at(-1);
    if (last && (tokens < last.tokens || now - last.time > 3000)) this.samples = [];
    if (this.samples.length && last && tokens > last.tokens) this.lastChange = now;
    this.samples.push({ time: now, tokens });
    while (this.samples.length > 1 && this.samples[1].time <= now - 3000) this.samples.shift();
    const first = this.samples[0];
    const seconds = (now - first.time) / 1000;
    if (seconds < 1 || now - this.lastChange >= 2000 || tokens <= first.tokens) return null;
    return (tokens - first.tokens) / seconds;
  }
}
