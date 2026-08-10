"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AttentionItem, AttentionResponse } from "@/lib/attention-center";

const STORAGE_KEY = "pi-attention-read-v1";
const POLL_MS = 15_000;

interface AttentionSnapshot {
  items: AttentionItem[];
  readIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}

let snapshot: AttentionSnapshot = {
  items: [],
  readIds: new Set(),
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

function hydrateReadIds(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      snapshot = { ...snapshot, readIds: new Set(parsed.filter((value): value is string => typeof value === "string").slice(-500)) };
    }
  } catch { /* keep an empty read set */ }
}

function persistReadIds(ids: ReadonlySet<string>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].slice(-500))); } catch { /* best effort */ }
}

async function loadAttention(quiet = false): Promise<void> {
  hydrateReadIds();
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
  hydrateReadIds();
  if (ids.length === 0) return;
  const next = new Set(snapshot.readIds);
  ids.forEach((id) => next.add(id));
  persistReadIds(next);
  emit({ ...snapshot, readIds: next });
}

export function useAttentionCenter() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  useEffect(() => {
    void loadAttention();
    const timer = window.setInterval(() => void loadAttention(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const unreadItems = useMemo(
    () => current.items.filter((item) => !current.readIds.has(item.id)),
    [current.items, current.readIds],
  );
  const refresh = useCallback(() => loadAttention(), []);
  const markItemRead = useCallback((id: string) => markRead([id]), []);
  const markAllRead = useCallback(() => markRead(current.items.map((item) => item.id)), [current.items]);

  return { ...current, unreadItems, unreadCount: unreadItems.length, refresh, markItemRead, markAllRead };
}
