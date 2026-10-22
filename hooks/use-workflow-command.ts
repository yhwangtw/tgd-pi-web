"use client";

import { useRef, useState } from "react";

/** Keep a single command in flight even when its card is hidden and remounted. */
export function useWorkflowCommand(scope: string | undefined, send: (message: string) => Promise<boolean>) {
  const active = useRef(new Map<string | undefined, object>());
  const [pendingRequests, setPendingRequests] = useState<ReadonlyMap<string | undefined, object>>(() => new Map());
  const run = async (message: string) => {
    if (active.current.has(scope)) return false;
    const request = {};
    active.current.set(scope, request);
    setPendingRequests(new Map(active.current));
    try { return await send(message); }
    finally {
      if (active.current.get(scope) === request) {
        active.current.delete(scope);
        setPendingRequests(new Map(active.current));
      }
    }
  };
  return { run, pending: pendingRequests.has(scope) };
}
