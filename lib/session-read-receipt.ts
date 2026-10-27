/** A content cursor, never a wall-clock "last opened" time. */
export interface SessionReadReceipt {
  timestamp: number;
  entryId?: string;
  /** Canonical append position, assigned only by the server. */
  position?: number;
}

export function isReadReceipt(value: unknown): value is SessionReadReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as SessionReadReceipt;
  return Number.isFinite(r.timestamp) && r.timestamp >= 0
    && (r.entryId === undefined || (typeof r.entryId === "string" && r.entryId.length > 0 && r.entryId.length <= 256))
    && (r.position === undefined || (Number.isSafeInteger(r.position) && r.position >= 0));
}

export function advancesReadReceipt(next: SessionReadReceipt, previous?: SessionReadReceipt): boolean {
  if (!previous) return true;
  if (next.timestamp !== previous.timestamp) return next.timestamp > previous.timestamp;
  if (!previous.entryId && next.entryId) return true;
  if (next.entryId === previous.entryId) return next.position !== undefined && previous.position === undefined;
  return next.position !== undefined && previous.position !== undefined && next.position > previous.position;
}
