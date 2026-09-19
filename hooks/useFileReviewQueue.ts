"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface ReviewScope { cwd: string | null; sessionId: string | null }

/** Background metadata only. Opening a review file is always a user action. */
export function useFileReviewQueue(cwd: string | null, sessionId: string | null) {
  // Identity changes even when navigating A -> B -> A, so old requests and
  // queues cannot leak back into a newly selected conversation.
  const scope = useMemo<ReviewScope>(() => ({ cwd, sessionId }), [cwd, sessionId]);
  const [request, setRequest] = useState<{ scope: ReviewScope } | null>(null);
  const [queue, setQueue] = useState<{ scope: ReviewScope; paths: string[] } | null>(null);

  useEffect(() => {
    if (!scope.cwd || request?.scope !== scope) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/git/changes?cwd=${encodeURIComponent(scope.cwd!)}`, { signal: controller.signal });
        if (!response.ok || controller.signal.aborted) return;
        const payload = await response.json() as { files?: Array<{ path: string }> };
        if (controller.signal.aborted) return;
        const paths = [...new Set((payload.files ?? []).map((file) => file.path))];
        setQueue({ scope, paths });
      } catch { /* Review metadata is optional; leave the reader undisturbed. */ }
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [request, scope]);

  const refreshReviewFiles = useCallback(() => setRequest({ scope }), [scope]);
  const markReviewed = useCallback((path: string) => {
    setQueue((current) => current?.scope === scope
      ? { ...current, paths: current.paths.filter((candidate) => candidate !== path) }
      : current);
  }, [scope]);

  return { pendingReviewFiles: queue?.scope === scope ? queue.paths : [], refreshReviewFiles, markReviewed };
}
