"use client";

import type { SessionInfo } from "./types";
import { advancesReadReceipt, isReadReceipt, type SessionReadReceipt } from "./session-read-receipt";

const PREFIX = "pi-session-read:";
const CURSOR = "pi-session-read-v2:";
const SCOPE = "pi-session-read-scope";
const LEGACY_SCOPE = "pi-session-read-legacy-scope";
const OUTBOX = "pi-session-read-outbox:";
const listeners = new Set<() => void>();
const memory = new Map<string, SessionReadReceipt>();
const server = new Map<string, SessionReadReceipt>();
const pending = new Map<string, string>();
const submitted = new Map<string, string>();
let scope: string | null = null;
let hydrated = false;
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;
function emit() { revision++; listeners.forEach(listener => listener()); }
function onStorage(event: StorageEvent) {
  const outboxPrefix = `${OUTBOX}${scope}:`;
  if (scope && event.key?.startsWith(outboxPrefix)) {
    const id = event.key.slice(outboxPrefix.length);
    if (event.newValue) { pending.set(id, event.newValue); scheduleSync(); }
    else if (pending.get(id) === event.oldValue) pending.delete(id);
  }
  if (event.key === null || event.key.startsWith(PREFIX) || event.key.startsWith(CURSOR) || event.key.startsWith("pi-last-read:")) emit();
}
export function subscribeSessionReads(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
export function getSessionReadRevision() { return revision; }
export function getServerSessionReadRevision() { return 0; }
export function hasSessionReadSnapshot() { return hydrated && scope !== null; }

export function getSessionReadReceipt(id: string): SessionReadReceipt | undefined {
  let receipt = memory.get(id);
  try {
    const effectiveScope = scope ?? localStorage.getItem(SCOPE);
    const raw = localStorage.getItem(`${CURSOR}${effectiveScope ?? "legacy"}:${id}`);
    const stored = raw ? JSON.parse(raw) : undefined;
    if (isReadReceipt(stored) && advancesReadReceipt(stored, receipt)) receipt = stored;
    if (!receipt && (!effectiveScope || localStorage.getItem(LEGACY_SCOPE) === effectiveScope)) {
      const timestamp = Number(localStorage.getItem(`${PREFIX}${id}`)) || 0;
      const entryId = localStorage.getItem(`pi-last-read:${id}`) || undefined;
      // Older versions could pair the maximum timestamp with an older scrolled-to ID.
      // Preserve their timestamp status without presenting that pair as a coherent cursor.
      if (timestamp || entryId) receipt = { timestamp, entryId: timestamp > 0 ? undefined : entryId };
    }
  } catch { /* private mode */ }
  return receipt;
}

function queueRead(id: string, entryId: string) {
  pending.set(id, entryId);
  if (scope) try { localStorage.setItem(`${OUTBOX}${scope}:${id}`, entryId); } catch { /* private mode */ }
}
function acknowledgeRead(id: string, entryId: string) {
  if (pending.get(id) === entryId) pending.delete(id);
  if (scope) try {
    const key = `${OUTBOX}${scope}:${id}`;
    if (localStorage.getItem(key) === entryId) localStorage.removeItem(key);
  } catch { /* private mode */ }
}

function persist(id: string, receipt: SessionReadReceipt) {
  memory.set(id, receipt);
  try { localStorage.setItem(`${CURSOR}${scope ?? localStorage.getItem(SCOPE) ?? "legacy"}:${id}`, JSON.stringify(receipt)); } catch { /* private mode */ }
}

/** Consume the existing session-list poll; do not create a second poller. */
export function mergeSessionReadSnapshot(value?: { scope?: unknown; receipts?: unknown }) {
  let changed = !hydrated;
  hydrated = true;
  if (value && typeof value.scope === "string" && value.receipts && typeof value.receipts === "object") {
    if (scope !== value.scope) {
      // A preview backed by another agent directory must not inherit this server's reads.
      if (scope !== null) { memory.clear(); pending.clear(); submitted.clear(); }
      server.clear(); scope = value.scope; changed = true;
      try {
        if (!localStorage.getItem(LEGACY_SCOPE)) localStorage.setItem(LEGACY_SCOPE, scope);
        localStorage.setItem(SCOPE, scope);
        const prefix = `${OUTBOX}${scope}:`;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(prefix)) continue;
          const id = key.slice(prefix.length), entryId = localStorage.getItem(key);
          if (/^[a-zA-Z0-9_-]{1,256}$/.test(id) && entryId && entryId.length <= 256) pending.set(id, entryId);
        }
      } catch { /* private mode */ }
    }
    for (const [id, receipt] of Object.entries(value.receipts)) {
      if (!isReadReceipt(receipt)) continue;
      if (advancesReadReceipt(receipt, server.get(id))) server.set(id, receipt);
      const local = getSessionReadReceipt(id);
      if (advancesReadReceipt(receipt, local)) { persist(id, receipt); changed = true; }
      else if (local?.entryId && local.timestamp === receipt.timestamp && local.entryId !== receipt.entryId
        && local.position === undefined && !pending.has(id) && submitted.get(id) !== local.entryId) {
        // Resolve this local cursor's canonical position before choosing between ties.
        queueRead(id, local.entryId);
      }
    }
  }
  if (changed) emit();
  if (pending.size && !sending) scheduleSync();
}

function scheduleSync() {
  if (timer || sending || !scope) return;
  timer = setTimeout(() => { timer = undefined; void flushSessionReads(); }, 400);
}

export async function flushSessionReads() {
  if (sending || !pending.size || !scope) return;
  sending = true;
  const batch = [...pending.entries()].slice(0, 32);
  let succeeded = false;
  try {
    const response = await fetch("/api/sessions/reads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, receipts: batch.map(([id, entryId]) => ({ id, entryId })) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (snapshot.scope !== scope || !snapshot.receipts || typeof snapshot.receipts !== "object") throw new Error("Invalid read snapshot");
    for (const [id, entryId] of batch) {
      const local = getSessionReadReceipt(id);
      const canonical = snapshot.receipts[id];
      // The server has now validated the exact local cursor we sent. Its merged
      // result is authoritative for a tie, unless this tab has advanced meanwhile.
      if (isReadReceipt(canonical) && local?.entryId === entryId && local.timestamp === canonical.timestamp
        && local.position === undefined && canonical.position !== undefined) {
        persist(id, canonical); emit();
      }
      submitted.set(id, entryId);
      acknowledgeRead(id, entryId);
    }
    mergeSessionReadSnapshot(snapshot);
    succeeded = true;
  } catch { /* Keep local progress. Retry on the next session-list refresh, not a hot loop. */ }
  finally {
    sending = false;
    if (succeeded && pending.size) scheduleSync();
  }
}

/** Advance only to visible content. Equal timestamps use known transcript order. */
export function markSessionRead(id: string, timestamp: number, entryId?: string, entryOrder?: readonly string[]) {
  if (!Number.isFinite(timestamp) || timestamp < 0) return;
  const previous = getSessionReadReceipt(id);
  const next = { timestamp, entryId };
  const previousIndex = previous?.entryId && entryOrder ? entryOrder.indexOf(previous.entryId) : -1;
  const laterAtSameTime = previous?.timestamp === timestamp && previousIndex >= 0 && !!entryId
    && (entryOrder?.indexOf(entryId) ?? -1) > previousIndex;
  if (advancesReadReceipt(next, previous) || laterAtSameTime) { persist(id, next); emit(); }
  const known = server.get(id);
  if (entryId && (!known || known.timestamp <= timestamp) && known?.entryId !== entryId && submitted.get(id) !== entryId) {
    // Scrolling back may not replace an unsent newer cursor.
    if (getSessionReadReceipt(id)?.entryId === entryId) { queueRead(id, entryId); scheduleSync(); }
  }
}

export function isSessionUnread(session: SessionInfo): boolean {
  if (session.ephemeral || session.messageCount === 0) return false;
  return ![session.id, session.sourceSessionId].some(id => {
    if (!id) return false;
    const receipt = getSessionReadReceipt(id);
    if (!receipt) return false;
    // At a tied timestamp a different entry can still be a new reply.
    if (session.lastMessageId && receipt.entryId === session.lastMessageId) return true;
    const modified = Date.parse(session.modified);
    return receipt.timestamp > modified || (receipt.timestamp === modified && (!session.lastMessageId || !receipt.entryId));
  });
}
