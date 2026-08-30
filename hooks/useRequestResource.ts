"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  emptyRequestSnapshot,
  getRequestSnapshot,
  invalidateRequest,
  loadRequest,
  subscribeRequest,
  type RequestLoadOptions,
} from "@/lib/request-state";

interface UseRequestResourceOptions extends Omit<RequestLoadOptions, "force"> {
  enabled?: boolean;
  debounceMs?: number;
}

export function useRequestResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: UseRequestResourceOptions = {},
) {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = options.enabled ?? true;
  const staleTimeMs = options.staleTimeMs;
  const retries = options.retries;
  const retryDelayMs = options.retryDelayMs;
  const debounceMs = Math.max(0, options.debounceMs ?? 0);

  const subscribe = useCallback((listener: () => void) => (
    key ? subscribeRequest(key, listener) : () => undefined
  ), [key]);
  const getSnapshot = useCallback(() => (
    key ? getRequestSnapshot<T>(key) : emptyRequestSnapshot<T>()
  ), [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => emptyRequestSnapshot<T>());

  useEffect(() => {
    if (!key || !enabled) return;
    const load = () => {
      void loadRequest(key, (signal) => fetcherRef.current(signal), {
        staleTimeMs,
        retries,
        retryDelayMs,
      }).catch(() => undefined);
    };
    if (debounceMs === 0) {
      load();
      return;
    }
    const timer = setTimeout(load, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, enabled, key, retries, retryDelayMs, staleTimeMs]);

  const refresh = useCallback(() => {
    if (!key || !enabled) return Promise.resolve(undefined);
    return loadRequest(key, (signal) => fetcherRef.current(signal), {
      staleTimeMs,
      retries,
      retryDelayMs,
      force: true,
    }).catch(() => undefined);
  }, [enabled, key, retries, retryDelayMs, staleTimeMs]);

  const invalidate = useCallback((dropData = false) => {
    if (key) invalidateRequest(key, dropData);
  }, [key]);

  return {
    ...snapshot,
    loading: snapshot.status === "loading",
    refreshing: snapshot.status === "refreshing",
    refresh,
    invalidate,
  };
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(input, { ...init, signal: signal ?? init.signal });
  const body = await response.json() as T & { error?: string };
  if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
