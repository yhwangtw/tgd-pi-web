import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  estimateTextTokens, generationMessageKey, validGenerationMetrics, type GenerationMetrics,
} from "./generation-metrics";
import type { AgentMessage, SessionEntry } from "./types";

export const GENERATION_METRICS_ENTRY = "pi-web-generation-metrics";

function assistant(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && (value as { role?: unknown }).role === "assistant"
    ? value as Record<string, unknown> : null;
}
function contentObserved(message: Record<string, unknown>): boolean {
  return Array.isArray(message.content) && message.content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const value = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (value.type === "text") return typeof value.text === "string" && value.text.length > 0;
    if (value.type === "thinking") return typeof value.thinking === "string" && value.thinking.length > 0;
    return value.type === "toolCall" || value.type === "image";
  });
}
function visibleText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block: unknown) => {
    const value = block as { type?: unknown; text?: unknown } | null;
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

/** Per-response host observations, independent of browser connections and clocks.
 * A provider boundary includes its wait for the first frame. Without the hook,
 * the interval starts at the SDK's message_start; unknown request latency stays
 * unknown, so the fallback does not publish a first-content latency.
 */
export class ServerGenerationMetricsTracker {
  private providerStart: number | null = null;
  private active: { start: number; provider: boolean; firstContent: number | null } | null = null;
  constructor(private readonly now = () => performance.now()) {}

  reset(): void { this.providerStart = null; this.active = null; }

  markProviderRequest(): void {
    // Concurrent diagnostics must not replace a response already being observed.
    // The actual next request can replace an unused pending boundary.
    if (!this.active) this.providerStart = this.now();
  }

  observe(event: { type?: unknown; message?: unknown }): GenerationMetrics | undefined {
    if (["agent_start", "agent_end", "auto_retry_start", "compaction_start", "auto_compaction_start"].includes(String(event.type))) {
      this.reset(); return;
    }
    if (!["message_start", "message_update", "message_end"].includes(String(event.type))) return;
    const message = assistant(event.message);
    if (!message) return;
    const now = this.now();
    if (event.type === "message_start") {
      this.active = { start: this.providerStart ?? now, provider: this.providerStart !== null, firstContent: null };
      this.providerStart = null;
    } else if (!this.active && this.providerStart !== null) {
      // A complete buffered frame needs no invented intermediate updates.
      this.active = { start: this.providerStart, provider: true, firstContent: null };
      this.providerStart = null;
    }
    const active = this.active;
    if (!active) return;
    if (active.firstContent === null && contentObserved(message)) active.firstContent = Math.max(active.start, now);
    if (event.type !== "message_end") return;
    this.active = null; this.providerStart = null;
    const seconds = (now - active.start) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const output = (message.usage as { output?: unknown } | undefined)?.output;
    const reliableUsage = typeof output === "number" && Number.isFinite(output) && output > 0;
    const text = visibleText(message);
    const tokens = reliableUsage ? output : text.trim() ? Math.max(1, Math.round(estimateTextTokens(text))) : 0;
    const metrics: GenerationMetrics = {
      tokens, seconds, estimated: !reliableUsage, source: "server",
      ...(active.provider && active.firstContent !== null
        ? { firstContentSeconds: Math.min(seconds, (active.firstContent - active.start) / 1000) } : {}),
    };
    return validGenerationMetrics(metrics) ? metrics : undefined;
  }
}

type MetricsSessionManager = Pick<SessionManager, "getBranch" | "getLeafId" | "appendCustomEntry">;

/** Called after Pi's public listener has returned and persisted the assistant.
 * Never advance a different branch or attach to a changed answer.
 */
export function persistGenerationMetrics(
  manager: MetricsSessionManager,
  previousLeafId: string | null,
  key: string,
  metrics: GenerationMetrics,
): boolean {
  if (!validGenerationMetrics(metrics) || metrics.source !== "server") return false;
  const branch = manager.getBranch();
  const entry = branch.at(-1);
  if (entry?.type !== "message" || entry.message.role !== "assistant"
    || entry.parentId !== previousLeafId || manager.getLeafId() !== entry.id
    || generationMessageKey(entry.message as unknown as AgentMessage) !== key) return false;
  manager.appendCustomEntry(GENERATION_METRICS_ENTRY, { version: 1, entryId: entry.id, key, metrics: { ...metrics } });
  return true;
}

/** Metadata belongs only to the selected branch and a preceding exact answer. */
export function readGenerationMetrics(path: SessionEntry[]): Record<string, GenerationMetrics> {
  const entries = new Map<string, SessionEntry>();
  const result: Record<string, GenerationMetrics> = {};
  for (const entry of path) {
    if (entry.type === "custom" && entry.customType === GENERATION_METRICS_ENTRY) {
      const data = entry.data as { version?: unknown; entryId?: unknown; key?: unknown; metrics?: unknown } | null;
      const target = typeof data?.entryId === "string" ? entries.get(data.entryId) : undefined;
      if (data?.version === 1 && typeof data.key === "string" && target?.type === "message"
        && target.message.role === "assistant" && entry.parentId === target.id
        && generationMessageKey(target.message) === data.key
        && validGenerationMetrics(data.metrics) && data.metrics.source === "server") {
        result[data.key] = { ...data.metrics };
      }
    }
    entries.set(entry.id, entry);
  }
  return result;
}
