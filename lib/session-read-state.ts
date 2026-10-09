"use client";

import type { SessionInfo } from "./types";

const PREFIX = "pi-session-read:";
const listeners = new Set<() => void>();
const memory = new Map<string, number>();
let revision = 0;
function emit() { revision++; listeners.forEach(listener => listener()); }
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key.startsWith(PREFIX) || event.key.startsWith("pi-last-read:")) emit();
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

function readTime(id: string): number {
  let stored = 0;
  try { stored = Number(localStorage.getItem(`${PREFIX}${id}`)) || 0; } catch { /* private mode */ }
  return Math.max(memory.get(id) ?? 0, stored);
}

/** Advance only to content actually visible, never to the wall clock. */
export function markSessionRead(id: string, timestamp: number, entryId?: string) {
  let changed = false;
  if (Number.isFinite(timestamp) && timestamp > readTime(id)) {
    memory.set(id, timestamp);
    try { localStorage.setItem(`${PREFIX}${id}`, String(timestamp)); } catch { /* private mode */ }
    changed = true;
  }
  if (entryId) {
    try {
      const key = `pi-last-read:${id}`;
      if (localStorage.getItem(key) !== entryId) {
        localStorage.setItem(key, entryId);
        changed = true;
      }
    } catch { /* private mode */ }
  }
  if (changed) emit();
}

export function isSessionUnread(session: SessionInfo): boolean {
  if (session.ephemeral || session.messageCount === 0) return false;
  if (Math.max(readTime(session.id), session.sourceSessionId ? readTime(session.sourceSessionId) : 0) >= Date.parse(session.modified)) return false;
  // Reuse read markers saved by older versions when they reach the latest message.
  try {
    if (session.lastMessageId && [session.id, session.sourceSessionId].some(id => id && localStorage.getItem(`pi-last-read:${id}`) === session.lastMessageId)) return false;
  } catch { /* private mode */ }
  return true;
}
