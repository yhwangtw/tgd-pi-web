"use client";

import { useEffect, useRef, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";

/**
 * File changes stay live without occupying HTTP/1's limited request slots.
 *
 * Multiplexed HTTP/2+ uses SSE; HTTP/1 (or an unknown protocol) checks a small
 * metadata revision once a second. Hidden tabs/panels release either transport
 * and reconcile when shown again. File contents are fetched only after change.
 *
 * @param filePath - Absolute path of the file to watch.
 * @returns `{ watching, refreshTrigger }` — `watching` is true while the
 *          monitor is healthy; `refreshTrigger` advances after observed edits.
 */
export function useFileWatch(filePath: string, enabled = true): {
  watching: boolean;
  refreshTrigger: number;
} {
  const [watching, setWatching] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const pathRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const revisionRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;
    let request: AbortController | null = null;
    let requestTimeout: ReturnType<typeof setTimeout> | null = null;
    setWatching(false);
    if (pathRef.current !== filePath) {
      pathRef.current = filePath;
      startedRef.current = false;
      revisionRef.current = null;
      dirtyRef.current = false;
      setRefreshTrigger(0);
    }
    const encoded = encodeFilePathForApi(filePath);
    const notify = () => {
      if (!active) return;
      dirtyRef.current = true;
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (active) { dirtyRef.current = false; setRefreshTrigger((n) => n + 1); }
      }, 100);
    };
    const observeRevision = (next: string) => {
      if (revisionRef.current !== null && revisionRef.current !== next) notify();
      revisionRef.current = next;
    };
    const stop = () => {
      generation++;
      source?.close();
      source = null;
      request?.abort();
      request = null;
      if (requestTimeout !== null) clearTimeout(requestTimeout);
      requestTimeout = null;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      pollTimer = refreshTimer = null;
      setWatching(false);
    };
    const start = () => {
      stop();
      if (!enabled || document.visibilityState === "hidden") return;
      const current = generation;
      const isCurrent = () => active && generation === current;
      const resumed = startedRef.current;
      // An edit queued just before hiding must survive timer cancellation.
      if (dirtyRef.current) notify();
      startedRef.current = true;
      const protocol = (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.nextHopProtocol;
      if (protocol === "h2" || protocol?.startsWith("h3")) {
        const es = new EventSource(`/api/files/${encoded}?type=watch`);
        source = es;
        let connected = false;
        const eventRevision = (event: Event): string | undefined => {
          try {
            const value = JSON.parse((event as MessageEvent).data).revision;
            return typeof value === "string" ? value : undefined;
          } catch { return undefined; }
        };
        es.addEventListener("connected", (event) => {
          if (!isCurrent()) return;
          const revision = eventRevision(event);
          if (revision !== undefined) observeRevision(revision);
          else if (resumed || connected) notify(); // Compatibility with older servers.
          connected = true;
          setWatching(true);
        });
        es.addEventListener("change", (event) => {
          if (!isCurrent()) return;
          const revision = eventRevision(event);
          if (revision !== undefined) observeRevision(revision);
          notify();
        });
        es.addEventListener("error", () => { if (isCurrent()) setWatching(false); });
        es.onerror = () => { if (isCurrent()) setWatching(false); };
        return;
      }
      const poll = async () => {
        const controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => controller.abort(), 8_000);
        requestTimeout = timeout;
        try {
          const response = await fetch(`/api/files/${encoded}?type=meta`, { cache: "no-store", signal: controller.signal });
          if (!isCurrent()) return;
          if (!response.ok) {
            const missing = `http:${response.status}`;
            if (revisionRef.current !== missing) { revisionRef.current = missing; notify(); }
            throw new Error(missing);
          }
          const data = await response.json() as { revision?: string };
          if (!isCurrent()) return;
          if (typeof data.revision !== "string") throw new Error("Invalid file revision");
          observeRevision(data.revision);
          setWatching(true);
        } catch {
          if (isCurrent()) setWatching(false);
        } finally {
          clearTimeout(timeout);
          if (requestTimeout === timeout) requestTimeout = null;
          if (request === controller) request = null;
          if (isCurrent()) pollTimer = setTimeout(() => { void poll(); }, 1_000);
        }
      };
      void poll();
    };
    const visibility = () => start();
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      stop();
    };
  }, [filePath, enabled]);

  return { watching, refreshTrigger };
}
