"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AttentionItem, AttentionResponse } from "@/lib/attention-center";

const STORAGE_KEY = "pi-attention-read-v1";
const CLEARED_STORAGE_KEY = "pi-attention-cleared-v1";
const POLL_MS = 15_000;

interface AttentionSnapshot {
  items: AttentionItem[];
  readIds: ReadonlySet<string>;
  clearedIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}

let snapshot: AttentionSnapshot = {
  items: [],
  readIds: new Set(),
  clearedIds: new Set(),
  loading: false,
  error: null,
  updatedAt: null,
};
let hydrated = false;
let pendingLoad: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: AttentionSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storedIds(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((value): value is string => typeof value === "string").slice(-500));
  } catch { /* keep an empty set */ }
  return new Set();
}

function hydrateIds(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  snapshot = {
    ...snapshot,
    readIds: storedIds(STORAGE_KEY),
    clearedIds: storedIds(CLEARED_STORAGE_KEY),
  };
}

function persistIds(key: string, ids: ReadonlySet<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...ids].slice(-500))); } catch { /* best effort */ }
}

async function loadAttention(quiet = false): Promise<void> {
  hydrateIds();
  if (pendingLoad) return pendingLoad;
  if (!quiet) emit({ ...snapshot, loading: true });
  pendingLoad = fetch("/api/attention", { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json() as Partial<AttentionResponse> & { error?: string };
      if (!response.ok || !Array.isArray(body.items)) throw new Error(body.error || `HTTP ${response.status}`);
      emit({ ...snapshot, items: body.items, loading: false, error: null, updatedAt: body.serverTime ?? new Date().toISOString() });
    })
    .catch((reason) => emit({ ...snapshot, loading: false, error: reason instanceof Error ? reason.message : String(reason) }))
    .finally(() => { pendingLoad = null; });
  return pendingLoad;
}

function markRead(ids: string[]): void {
  hydrateIds();
  if (ids.length === 0) return;
  const next = new Set(snapshot.readIds);
  ids.forEach((id) => next.add(id));
  persistIds(STORAGE_KEY, next);
  emit({ ...snapshot, readIds: next });
}

function clearCompleted(ids: string[]): void {
  hydrateIds();
  const completed = new Set(snapshot.items.filter((item) => item.status === "completed").map((item) => item.id));
  const eligible = ids.filter((id) => completed.has(id));
  if (eligible.length === 0) return;
  const next = new Set(snapshot.clearedIds);
  eligible.forEach((id) => next.add(id));
  persistIds(CLEARED_STORAGE_KEY, next);
  emit({ ...snapshot, clearedIds: next });
}

export function useAttentionCenter() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  useEffect(() => {
    void loadAttention();
    const timer = window.setInterval(() => void loadAttention(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const visibleItems = useMemo(
    () => current.items.filter((item) => !current.clearedIds.has(item.id)),
    [current.clearedIds, current.items],
  );
  const unreadItems = useMemo(
    () => visibleItems.filter((item) => !current.readIds.has(item.id)),
    [current.readIds, visibleItems],
  );
  const refresh = useCallback(() => loadAttention(), []);
  const markItemRead = useCallback((id: string) => markRead([id]), []);
  const markAllRead = useCallback(() => markRead(visibleItems.map((item) => item.id)), [visibleItems]);
  const clearCompletedItems = useCallback((ids: string[]) => clearCompleted(ids), []);

  return {
    ...current,
    items: visibleItems,
    unreadItems,
    unreadCount: unreadItems.length,
    refresh,
    markItemRead,
    markAllRead,
    clearCompleted: clearCompletedItems,
  };
}
