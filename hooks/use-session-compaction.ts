"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { classifyCompactionError, type CompactionState } from "@/lib/compaction-state";
import type { QueuedFollowUp } from "@/lib/queued-follow-ups";
import type { AgentEvent, AttachedImage } from "./use-agent-session-types";

export type CompactionView = CompactionState | { id: string; status: "checking" | "unknown"; reason: string; startedAt: number };
export interface CompactionLiveState {
  isCompacting?: boolean;
  compaction?: CompactionState | null;
  compactionQueue?: QueuedFollowUp[];
}

export function useSessionCompaction(
  sessionIdRef: RefObject<string | null>,
  setIsCompacting: (running: boolean) => void,
  onCompleted: () => void,
  connectEvents: (id: string) => Promise<boolean>,
) {
  const [view, setView] = useState<CompactionView | null>(null);
  const [queue, setQueue] = useState<QueuedFollowUp[]>([]);
  const viewRef = useRef(view);
  const awaitingId = useRef<string | null>(null);
  const starting = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const completed = useRef(new Set<string>());
  const dismissed = useRef<string | null>(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const update = useCallback((next: CompactionView | null) => {
    if (!mounted.current) return;
    viewRef.current = next;
    setView(next);
    setIsCompacting(next?.status === "running" || next?.status === "checking");
  }, [setIsCompacting]);

  const accept = useCallback((state: CompactionState, force = false) => {
    const current = viewRef.current;
    if (!force && awaitingId.current && state.id !== awaitingId.current && state.status !== "running") return;
    if (current?.id === state.id && !["running", "checking", "unknown"].includes(current.status) && state.status === "running") return;
    if (state.id === awaitingId.current || force || state.status === "running") awaitingId.current = null;
    if (dismissed.current !== state.id || state.status === "running") update(state);
    if (state.status === "completed" && !completed.current.has(state.id)) {
      completed.current.add(state.id);
      onCompletedRef.current();
    }
  }, [update]);

  const reconcile = useCallback((state?: CompactionLiveState) => {
    if (!state || !mounted.current) return;
    if (state.compactionQueue) setQueue(state.compactionQueue);
    if (state.compaction) accept(state.compaction);
    else if (state.isCompacting) update({ id: "native", status: "running", reason: "auto", startedAt: Date.now() });
  }, [accept, update]);

  const check = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const checkedId = viewRef.current?.id;
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout?.(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as { running: boolean; state?: CompactionLiveState };
      if (!mounted.current || sid !== sessionIdRef.current || checkedId !== viewRef.current?.id) return;
      if (result.state?.compaction && (!awaitingId.current || result.state.compaction.id === awaitingId.current || result.state.compaction.status === "running")) reconcile(result.state);
      else if (result.state?.isCompacting) reconcile(result.state);
      else if (viewRef.current && ["running", "checking"].includes(viewRef.current.status)) {
        // No live job proves it is not still running, but does not prove success/failure.
        update({ ...viewRef.current, status: "unknown" });
      }
    } catch {
      if (mounted.current && sid === sessionIdRef.current && checkedId === viewRef.current?.id && viewRef.current && ["running", "checking"].includes(viewRef.current.status)) {
        update({ ...viewRef.current, status: "checking" });
      }
    }
  }, [sessionIdRef, reconcile, update]);

  const start = useCallback(async (instructions?: string) => {
    const sid = sessionIdRef.current;
    if (!sid || starting.current || ["running", "checking"].includes(viewRef.current?.status ?? "")) return;
    const id = globalThis.crypto?.randomUUID?.() ?? `compact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    awaitingId.current = id;
    update({ id, status: "running", reason: "manual", startedAt: Date.now() });
    const pending = (async () => {
      try {
        const state = await sendAgentCommand<CompactionState>(sid, { type: "compact", background: true, requestId: id, ...(instructions ? { customInstructions: instructions } : {}) }, AbortSignal.timeout?.(15_000));
        if (mounted.current && sid === sessionIdRef.current) {
          accept(state, true);
          void connectEvents(sid).catch(() => {});
        }
      } catch {
        // Transport loss is ambiguous. Never auto-repeat a potentially accepted model request.
        if (mounted.current && sid === sessionIdRef.current && viewRef.current?.id === id && viewRef.current.status === "running") {
          update({ ...viewRef.current, status: "checking" });
          await check();
        }
      }
    })();
    starting.current = pending;
    try { await pending; } finally { starting.current = null; }
  }, [sessionIdRef, accept, check, connectEvents, update]);

  const handleEvent = useCallback((event: AgentEvent) => {
    if (event.type === "compaction_status") { accept(event.compaction as CompactionState); return true; }
    if (event.type === "compaction_queue") { setQueue(event.items as QueuedFollowUp[]); return true; }
    if (event.type === "compaction_queue_error") {
      update({ id: "queue", status: "failed", reason: "queue", startedAt: Date.now(), error: String(event.message) });
      return true;
    }
    if (!["compaction_start", "auto_compaction_start", "compaction_end", "auto_compaction_end", "session_compact_failed"].includes(event.type)) return false;
    if (event.webManaged) return true; // Rich status already emitted; do not toast twice.
    if (event.type.endsWith("_start")) update({ id: `native-${Date.now()}`, status: "running", reason: String(event.reason ?? "auto"), startedAt: Date.now() });
    else {
      const current = viewRef.current;
      accept({ id: current?.id ?? `native-${Date.now()}`, reason: String(event.reason ?? "auto"), startedAt: current?.startedAt ?? Date.now(),
        ...(event.aborted ? { status: "cancelled" as const } : (event.errorMessage || event.error || event.type === "session_compact_failed") ? classifyCompactionError(event.errorMessage ?? event.error ?? "Compaction failed") : event.result ? { status: "completed" as const, result: event.result as CompactionState["result"] } : { status: "skipped" as const, notice: "nothing_to_compact" as const }),
      });
    }
    return true;
  }, [accept, update]);

  const abort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await starting.current;
    try { await sendAgentCommand(sid, { type: "abort_compaction" }); } catch { /* Reconcile; cancellation may have arrived. */ }
    await check();
  }, [sessionIdRef, check]);

  const enqueue = useCallback(async (message: string, images?: AttachedImage[], mode: "steer" | "followUp" = "followUp") => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    await starting.current;
    if (sid !== sessionIdRef.current || ["checking", "unknown"].includes(viewRef.current?.status ?? "")) return false;
    const id = globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await sendAgentCommand(sid, { type: "queue_compaction_prompt", id, message, mode, ...(images?.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) });
      await check();
      return true;
    } catch { await check(); return false; }
  }, [sessionIdRef, check]);

  const clearQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await sendAgentCommand(sid, { type: "clear_compaction_queue" });
    setQueue([]);
  }, [sessionIdRef]);

  const activeId = view?.id;
  const activeStatus = view?.status;
  useEffect(() => {
    if (!activeId || !["running", "checking"].includes(activeStatus ?? "")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await check(); if (!cancelled) timer = setTimeout(poll, 2500); };
    timer = setTimeout(poll, 2500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeId, activeStatus, check]);

  const retry = useCallback(async () => {
    if (viewRef.current?.reason !== "queue") return start();
    const sid = sessionIdRef.current;
    if (sid) await sendAgentCommand(sid, { type: "retry_compaction_queue" });
    await check();
  }, [sessionIdRef, start, check]);

  return { view, queue, start, retry, abort, check, enqueue, clearQueue, reconcile, handleEvent, dismiss: () => { dismissed.current = viewRef.current?.id ?? null; update(null); } };
}
