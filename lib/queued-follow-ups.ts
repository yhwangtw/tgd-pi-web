export interface QueuedFollowUpImage {
  data: string;
  mimeType: string;
}

export interface QueuedFollowUp {
  id: string;
  message: string;
  images?: QueuedFollowUpImage[];
  deliveryMode?: "steer" | "followUp";
}

/** Normalize persisted and live follow-up queues without losing UI identity. */
export function normalizeQueuedFollowUps(event: Record<string, unknown>, previous: QueuedFollowUp[] = []): QueuedFollowUp[] {
  const used = new Set<string>();
  let candidates = previous;
  if (!Array.isArray(event.items) && (Array.isArray(event.steering) || Array.isArray(event.followUp))) {
    // SDK removes the oldest occurrence when identical queued messages are consumed.
    candidates = previous.filter((item, index) => {
      const mode = item.deliveryMode ?? "followUp";
      const current = mode === "steer" ? event.steering : event.followUp;
      const remaining = Array.isArray(current) ? current.filter(text => text === item.message).length : 0;
      const later = previous.slice(index).filter(other => other.message === item.message && (other.deliveryMode ?? "followUp") === mode).length;
      return later <= remaining;
    });
  }
  const normalize = (value: unknown, deliveryMode: "steer" | "followUp"): QueuedFollowUp | null => {
    const source = typeof value === "string" ? { message: value } : value;
    if (!source || typeof source !== "object" || !("message" in source) || typeof source.message !== "string") return null;
    const item = source as Partial<QueuedFollowUp> & { message: string };
    const mode = item.deliveryMode === "steer" || item.deliveryMode === "followUp" ? item.deliveryMode : deliveryMode;
    const prior = candidates.find(candidate => !used.has(candidate.id) &&
      (item.id ? candidate.id === item.id : candidate.message === item.message && (candidate.deliveryMode ?? "followUp") === mode));
    const id = typeof item.id === "string" && item.id ? item.id : prior?.id || globalThis.crypto.randomUUID();
    used.add(id);
    const images = Array.isArray(item.images) ? item.images.filter(image => image && typeof image.data === "string" && typeof image.mimeType === "string") : prior?.images;
    return { id, message: item.message, deliveryMode: mode, ...(images?.length ? { images } : {}) };
  };
  if (Array.isArray(event.items)) return event.items.map(item => normalize(item, "followUp")).filter((item): item is QueuedFollowUp => item !== null);
  if (Array.isArray(event.steering) || Array.isArray(event.followUp)) return [
    ...(Array.isArray(event.steering) ? event.steering.map(item => normalize(item, "steer")) : []),
    ...(Array.isArray(event.followUp) ? event.followUp.map(item => normalize(item, "followUp")) : []),
  ].filter((item): item is QueuedFollowUp => item !== null);
  return previous;
}

export function moveQueuedFollowUp(
  items: QueuedFollowUp[],
  id: string,
  direction: -1 | 1,
): QueuedFollowUp[] {
  const index = items.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length || (items[index].deliveryMode ?? "followUp") !== (items[target].deliveryMode ?? "followUp")) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function updateQueuedFollowUp(
  items: QueuedFollowUp[],
  id: string,
  message: string,
): QueuedFollowUp[] {
  return items.map((item) => item.id === id ? { ...item, message } : item);
}
