// Notification receipts contain identifiers only, never summaries or errors.
// Keep them outside the session component so navigation and reload do not
// replay an acknowledged result. Other tabs on the same origin share receipts.
const STORAGE_KEY = "pi-compaction-notices-v1";
const MAX_RECEIPTS = 200;
const receipts = new Set<string>();

function trimReceipts() {
  while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.values().next().value!);
}

function readReceipts() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      for (const key of stored.slice(-MAX_RECEIPTS)) {
        if (typeof key === "string") receipts.add(key);
      }
      trimReceipts();
    }
  } catch { /* Storage may be unavailable; the in-memory receipts still work. */ }
}

export function hasCompactionNoticeReceipt(sessionId: string | null, id: string, status: string): boolean {
  if (!sessionId) return false;
  readReceipts();
  return receipts.has(JSON.stringify([sessionId, id, status]));
}

export function rememberCompactionNotice(sessionId: string | null, id: string, status: string): void {
  if (!sessionId) return;
  readReceipts();
  const key = JSON.stringify([sessionId, id, status]);
  receipts.delete(key);
  receipts.add(key);
  trimReceipts();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...receipts])); } catch { /* Optional persistence. */ }
}

/** Test hook: simulate a fresh page while retaining browser storage. */
export function resetCompactionNoticeCache(): void {
  receipts.clear();
}
