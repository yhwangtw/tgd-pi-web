import type { AgentMessage } from "@/lib/types";

interface StreamUpdateSchedulerOptions<T> {
  publish: (value: T) => void;
  hasContent: (value: T) => boolean;
  /** Cheap size estimate: inspect block/string lengths, never stringify content. */
  size: (value: T) => number;
  isCurrent?: (value: T) => boolean;
  isHidden?: () => boolean;
  now?: () => number;
}

/**
 * Deliver the first visible content without a timer. Later snapshots replace one
 * pending value, at 16 ms for short/light output and 33/80 ms for long output or
 * a busy event loop. Timers also run in background tabs; visibility can flush the
 * latest value rather than waiting for a throttled timer or animation frame.
 */
export function createStreamUpdateScheduler<T>(options: StreamUpdateSchedulerOptions<T>) {
  const now = options.now ?? (() => performance.now());
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let hasContent = false;
  let lastPublishedAt = -Infinity;
  let interval = 16;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const cancel = () => {
    generation += 1;
    clearTimer();
    pending = null;
    hasContent = false;
    lastPublishedAt = -Infinity;
    interval = 16;
  };
  const publish = (value: T, lateness = 0) => {
    if (options.isCurrent && !options.isCurrent(value)) return;
    lastPublishedAt = now();
    // Payload length estimates parse cost; timer lateness detects main-thread
    // pressure without scanning Markdown or adding a React render per chunk.
    const size = options.size(value);
    interval = size >= 120_000 || lateness >= 32 ? 80 : size >= 24_000 || lateness >= 8 ? 33 : 16;
    options.publish(value);
  };
  const flush = () => {
    clearTimer();
    const value = pending;
    pending = null;
    if (value !== null) publish(value);
  };
  return {
    start(value: T) {
      cancel();
      hasContent = options.hasContent(value);
      publish(value);
    },
    push(value: T) {
      if (options.isCurrent && !options.isCurrent(value)) return;
      if (!hasContent) {
        // Only inspect blocks until the first real output. Once streaming, the
        // latest snapshot can be queued in constant time regardless of length.
        if (!options.hasContent(value)) return;
        hasContent = true;
        clearTimer();
        pending = null;
        publish(value);
        return;
      }
      pending = value;
      if (timer !== null) return;
      const delay = Math.max(0, (options.isHidden?.() ? Math.max(80, interval) : interval) - (now() - lastPublishedAt));
      if (delay === 0) { flush(); return; }
      const scheduledGeneration = generation;
      const deadline = now() + delay;
      timer = setTimeout(() => {
        if (generation !== scheduledGeneration) return;
        timer = null;
        const latest = pending;
        pending = null;
        if (latest !== null) publish(latest, Math.max(0, now() - deadline));
      }, delay);
    },
    flush,
    cancel,
  };
}

export function hasStreamMessageContent(message: AgentMessage): boolean {
  if ("output" in message) return message.output.length > 0;
  if (typeof message.content === "string") return message.content.length > 0;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(block => {
    if (block.type === "text") return block.text.length > 0;
    if (block.type === "thinking") return block.thinking.length > 0;
    // A tool name or image is visible output even before its body is complete.
    return block.type === "toolCall" || block.type === "image";
  });
}

export function streamMessageSize(message: AgentMessage): number {
  if ("output" in message) return message.output.length;
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;
  let size = 0;
  for (const block of message.content) {
    if (block.type === "text") size += block.text.length;
    else if (block.type === "thinking") size += block.thinking.length;
    else size += 256;
  }
  return size;
}
