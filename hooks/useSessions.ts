"use client";

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { getSessionListSnapshot, getServerSessionListSnapshot, refreshSessionList, subscribeSessionList } from "@/lib/session-list-store";

/**
 * Manages session list loading, pinned sessions, and refresh indicator.
 *
 * @param refreshKey - When this number changes, sessions are reloaded (without loading spinner).
 */
export function useSessions(refreshKey?: number) {
  const { allSessions, loading, error } = useSyncExternalStore(subscribeSessionList, getSessionListSnapshot, getServerSessionListSnapshot);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSessions = useCallback(async (showLoading = false, notify = true) => {
    const success = await refreshSessionList(!showLoading);
    if (success && !showLoading && notify) {
      setSessionRefreshDone(true);
      if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
    }
  }, []);

  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
  }, []);

  const loadPins = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions/pins");
      if (!res.ok) return;
      const data = await res.json() as { pinned?: string[] };
      setPinnedIds(Array.isArray(data.pinned) ? data.pinned : []);
    } catch {
      // Pins are best-effort; missing file is fine.
    }
  }, []);

  const handlePinToggle = useCallback(async (id: string) => {
    const isPinned = pinnedIds.includes(id);
    // Optimistic update so the star flips immediately.
    setPinnedIds((prev) =>
      isPinned ? prev.filter((x) => x !== id) : [id, ...prev.filter((x) => x !== id)],
    );
    try {
      const res = await fetch("/api/sessions/pins", {
        method: isPinned ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        // Roll back on server error.
        setPinnedIds((prev) =>
          isPinned ? [id, ...prev.filter((x) => x !== id)] : prev.filter((x) => x !== id),
        );
      }
    } catch {
      // Roll back on network error.
      setPinnedIds((prev) =>
        isPinned ? [id, ...prev.filter((x) => x !== id)] : prev.filter((x) => x !== id),
      );
    }
  }, [pinnedIds]);

  // Archived ids mirror the pins flow (server file + optimistic toggle).
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const loadArchive = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions/archive");
      if (!res.ok) return;
      const data = await res.json() as { archived?: string[] };
      setArchivedIds(Array.isArray(data.archived) ? data.archived : []);
    } catch {
      // best-effort
    }
  }, []);

  const handleArchiveToggle = useCallback(async (id: string) => {
    const isArchived = archivedIds.includes(id);
    setArchivedIds((prev) =>
      isArchived ? prev.filter((x) => x !== id) : [id, ...prev.filter((x) => x !== id)],
    );
    try {
      const res = await fetch("/api/sessions/archive", {
        method: isArchived ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setArchivedIds((prev) =>
          isArchived ? [id, ...prev.filter((x) => x !== id)] : prev.filter((x) => x !== id),
        );
      }
    } catch {
      setArchivedIds((prev) =>
        isArchived ? [id, ...prev.filter((x) => x !== id)] : prev.filter((x) => x !== id),
      );
    }
  }, [archivedIds]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, false);
    loadPins();
    loadArchive();
  }, [loadSessions, loadPins, loadArchive, refreshKey]);

  return { allSessions, loading, error, pinnedIds, sessionRefreshDone, loadSessions, handlePinToggle, archivedIds, handleArchiveToggle };
}
