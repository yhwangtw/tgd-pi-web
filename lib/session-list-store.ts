"use client";

import type { SessionInfo } from "./types";

export const SESSION_POLL_MS = 5_000;
const EMPTY = { allSessions: [] as SessionInfo[], loading: true, error: null as string | null };
let snapshot = EMPTY;
let pending: Promise<boolean> | null = null;
let refreshAgain = false;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
// Pi may not persist a new conversation until its first assistant message.
const optimistic = new Map<string, SessionInfo>();

function publish(next: typeof snapshot) {
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  listeners.forEach(listener => listener());
}

export function getSessionListSnapshot() { return snapshot; }
export function getServerSessionListSnapshot() { return EMPTY; }

export function rememberNewSession(session: SessionInfo) {
  if (session.ephemeral) return;
  optimistic.set(session.id, session);
  publish({ ...snapshot, allSessions: [session, ...snapshot.allSessions.filter(item => item.id !== session.id)] });
  void refreshSessionList(true);
}

export function forgetSession(id: string) {
  optimistic.delete(id);
  publish({ ...snapshot, allSessions: snapshot.allSessions.filter(session => session.id !== id) });
}

/** One request/poller shared by the sidebar and command palette. */
export function refreshSessionList(invalidate = false): Promise<boolean> {
  if (pending) {
    refreshAgain ||= invalidate;
    return pending;
  }
  pending = (async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { sessions?: SessionInfo[] };
      if (!Array.isArray(data.sessions)) throw new Error("Invalid session list");
      const sessions = data.sessions;
      for (const [id, session] of optimistic) {
        if (sessions.some(item => item.id === id)) optimistic.delete(id);
        else sessions.push(session);
      }
      sessions.sort((a, b) => b.modified.localeCompare(a.modified));
      publish({ allSessions: sessions, loading: false, error: null });
      return true;
    } catch (error) {
      publish({ ...snapshot, loading: false, error: String(error) });
      return false;
    } finally {
      pending = null;
      if (refreshAgain) {
        refreshAgain = false;
        if (listeners.size) void refreshSessionList();
      }
    }
  })();
  return pending;
}

function refreshVisible() {
  if (document.visibilityState !== "hidden") void refreshSessionList();
}

export function subscribeSessionList(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(refreshVisible, SESSION_POLL_MS);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearInterval(timer);
    refreshAgain = false;
    window.removeEventListener("focus", refreshVisible);
    window.removeEventListener("online", refreshVisible);
    document.removeEventListener("visibilitychange", refreshVisible);
  };
}
