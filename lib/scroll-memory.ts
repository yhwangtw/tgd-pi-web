// ============================================================================
// Per-session transcript scroll memory. ChatWindow remounts on every session
// switch (key={sessionKey}), so positions live in a module-level map — they
// survive switches and reloads in the same browser tab. A new tab starts at
// the usual tail rather than importing another tab's reading position.
// ============================================================================

/** Sentinel: the reader was at (or near) the bottom — keep following. */
export const AT_BOTTOM = -1;

const positions = new Map<string, number>();
const STORAGE_KEY = "pi-transcript-positions";
const MAX_POSITIONS = 200;

export type TranscriptHistoryKey = string | number;
const historyStarts = new Map<string, TranscriptHistoryKey>();
const HISTORY_STORAGE_KEY = "pi-transcript-history-starts";

/** First mounted logical row. Stored separately to keep old pixel records valid. */
export function saveTranscriptHistoryStart(key: string | null | undefined, firstKey: TranscriptHistoryKey): void {
  if (!key) return;
  historyStarts.set(key, firstKey);
  if (historyStarts.size > MAX_POSITIONS) historyStarts.delete(historyStarts.keys().next().value!);
  try { sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([...historyStarts])); } catch { /* Optional tab-local persistence. */ }
}

export function loadTranscriptHistoryStart(key: string | null | undefined): TranscriptHistoryKey | undefined {
  if (!key) return undefined;
  if (!historyStarts.has(key)) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]");
      if (Array.isArray(stored)) for (const item of stored.slice(-MAX_POSITIONS)) {
        if (Array.isArray(item) && typeof item[0] === "string"
          && (typeof item[1] === "string" || (typeof item[1] === "number" && Number.isFinite(item[1])))
          && !historyStarts.has(item[0])) historyStarts.set(item[0], item[1]);
      }
    } catch { /* Optional tab-local persistence. */ }
  }
  return historyStarts.get(key);
}

export function saveScrollPosition(key: string | null | undefined, scrollTop: number, distToBottom: number): void {
  if (!key) return;
  // Near-bottom readers get the sentinel so new content still opens at the
  // tail (an absolute offset would pin them above messages that arrived
  // while they were away).
  positions.set(key, distToBottom < 40 ? AT_BOTTOM : scrollTop);
  if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!);
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...positions])); } catch { /* Private mode or quota. */ }
}

export function loadScrollPosition(key: string | null | undefined): number | undefined {
  if (!key) return undefined;
  if (!positions.has(key)) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(stored)) for (const item of stored.slice(-MAX_POSITIONS)) {
        if (Array.isArray(item) && typeof item[0] === "string" && Number.isFinite(item[1]) && item[1] >= AT_BOTTOM && !positions.has(item[0])) positions.set(item[0], item[1]);
      }
    } catch { /* Optional tab-local persistence. */ }
  }
  return positions.get(key);
}

/** Test hook. */
export function clearScrollPositions(): void {
  positions.clear();
  historyStarts.clear();
  try { sessionStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem(HISTORY_STORAGE_KEY); } catch { /* unavailable */ }
}
