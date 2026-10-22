"use client";

import { useEffect, useRef, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";

/**
 * Hook that manages an SSE file-watch connection for live file updates.
 *
 * Opens an EventSource to `/api/files/{encoded}?type=watch` for the given
 * filePath. Each "change" event from the server increments `refreshTrigger`
 * so the caller can react (e.g., re-fetch content, bust an image cache).
 *
 * @param filePath - Absolute path of the file to watch.
 * @returns `{ watching, refreshTrigger }` — `watching` is true while the
 *          SSE connection is live; `refreshTrigger` increments on each
 *          change event (use as a useEffect dependency).
 */
export function useFileWatch(filePath: string): {
  watching: boolean;
  refreshTrigger: number;
} {
  const [watching, setWatching] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    setWatching(false);
    setRefreshTrigger(0);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeFilePathForApi(filePath);
    const es = new EventSource(`/api/files/${encoded}?type=watch`);
    esRef.current = es;

    es.addEventListener("connected", () => {
      if (active) setWatching(true);
    });

    es.addEventListener("change", () => {
      if (!active || refreshTimer !== null) return;
      // Editors often emit several fs events per write. Coalesce before React
      // state/media URLs change, with a bounded delay even during steady writes.
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (active) setRefreshTrigger((n) => n + 1);
      }, 100);
    });

    es.addEventListener("error", () => {
      if (active) setWatching(false);
    });

    es.onerror = () => {
      if (active) setWatching(false);
    };

    return () => {
      active = false;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      es.close();
      esRef.current = null;
    };
  }, [filePath]);

  return { watching, refreshTrigger };
}
