"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { AgentEvent, AgentPhase, RunProgressState } from "./use-agent-session-types";

const HEALTHY_PROGRESS: RunProgressState = {
  idleSeconds: 0,
  attention: "normal",
  connection: "connected",
};

export function isDuplicateAgentCursor(previous: string | null, next: string): boolean {
  if (!previous || !next) return false;
  const split = (cursor: string) => {
    const at = cursor.lastIndexOf(":");
    return { epoch: cursor.slice(0, at), sequence: Number(cursor.slice(at + 1)) };
  };
  const before = split(previous);
  const after = split(next);
  return before.epoch === after.epoch && Number.isSafeInteger(after.sequence) && after.sequence <= before.sequence;
}

/**
 * SSE wiring for a live agent run: owns the EventSource, the
 * last-event timestamp, and reconnect-with-backoff. Events are delivered
 * through `handleAgentEventRef` so the handler can close over fresh state
 * without re-creating the connection.
 */
export function useAgentEvents(
  agentRunningRef: React.RefObject<boolean>,
  handleAgentEventRef: React.RefObject<((event: AgentEvent) => void) | null>,
) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);
  const [mountedAt] = useState(() => Date.now());
  const lastEventAtRef = useRef(mountedAt);
  const reconnectAttemptRef = useRef(0);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const [connectionState, setConnectionState] = useState<RunProgressState["connection"]>("connected");
  const sessionRef = useRef<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const pendingReadyRef = useRef<Promise<boolean> | null>(null);
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failSafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settlePendingRef = useRef<((ok: boolean) => void) | null>(null);

  // Resolves `true` after the authoritative snapshot has been applied, not
  // merely after HTTP open (an old idle snapshot must precede a new prompt).
  // Resolves `false` when the stream isn't ready
  // yet (failsafe timeout / connect error) — a broken stream never blocks the
  // caller, but it can tell the difference and log it.
  const connectEvents = useCallback((sid: string, forceReconnect = false): Promise<boolean> => {
    if (!mountedRef.current) return Promise.resolve(false);
    const current = eventSourceRef.current;
    if (!forceReconnect && current && sessionRef.current === sid && current.readyState !== EventSource.CLOSED) {
      return readyRef.current ? Promise.resolve(true) : pendingReadyRef.current ?? Promise.resolve(false);
    }
    if (sessionRef.current !== sid) {
      cursorRef.current = null;
      reconnectAttemptRef.current = 0;
      reconnectStartedAtRef.current = null;
    }
    sessionRef.current = sid;
    const generation = ++generationRef.current;
    settlePendingRef.current?.(false);
    if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
    if (failSafeRef.current !== null) clearTimeout(failSafeRef.current);
    reconnectTimerRef.current = null;
    current?.close();
    readyRef.current = false;
    const url = `/api/agent/${encodeURIComponent(sid)}/events${cursorRef.current ? `?cursor=${encodeURIComponent(cursorRef.current)}` : ""}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;
    const pending = new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (failSafeRef.current !== null) clearTimeout(failSafeRef.current);
        resolve(ok);
      };
      settlePendingRef.current = settle;
      failSafeRef.current = setTimeout(() => settle(false), 1_500);
      es.onopen = () => {
        if (eventSourceRef.current !== es) return;
        setConnectionState("connected");
      };
      es.onmessage = (e) => {
        if (eventSourceRef.current !== es) return;
        setConnectionState("connected");
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          const snapshot = event.type === "session_snapshot";
          const sequenced = event.type !== "connected" && !event.type.startsWith("extension_ui_");
          if (sequenced && !snapshot && e.lastEventId && isDuplicateAgentCursor(cursorRef.current, e.lastEventId)) return;
          handleAgentEventRef.current?.(event);
          if (sequenced && e.lastEventId) cursorRef.current = e.lastEventId;
          if (event.type === "session_closed") {
            settle(false);
            readyRef.current = false;
            es.close();
            eventSourceRef.current = null;
            return;
          }
          if (snapshot) {
            readyRef.current = true;
            reconnectAttemptRef.current = 0;
            reconnectStartedAtRef.current = null;
            settle(true);
          } else if (event.type !== "connected") {
            // Transport/bootstrap snapshots are not meaningful model progress.
            lastEventAtRef.current = Date.now();
          }
        } catch {
          // Leave the cursor unchanged so a malformed/unhandled frame is not
          // acknowledged as delivered; reconnect can recover from a snapshot.
        }
      };
      es.onerror = () => {
        settle(false); // no-op after open — only fails a still-pending await
        if (eventSourceRef.current === es) {
          if (reconnectStartedAtRef.current === null) reconnectStartedAtRef.current = Date.now();
          const reconnectingFor = Date.now() - reconnectStartedAtRef.current;
          // Mobile radios and browsers routinely blip during network changes.
          // Keep the first two attempts visually quiet; promote only a
          // sustained transport problem, separate from model latency.
          if (agentRunningRef.current && (reconnectAttemptRef.current >= 2 || reconnectingFor >= 10_000)) {
            setConnectionState("reconnecting");
          }
          es.close();
          eventSourceRef.current = null;
          // Exponential backoff: 1s, 2s, 4s, ... capped at 15s, so a downed
          // server isn't hammered once per second.
          const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 15_000);
          reconnectAttemptRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            if (generationRef.current === generation && sessionRef.current === sid) void connectEvents(sid);
          }, delay);
        }
      };
    });
    pendingReadyRef.current = pending;
    return pending;
  }, [agentRunningRef, handleAgentEventRef]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      settlePendingRef.current?.(false);
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
      if (failSafeRef.current !== null) clearTimeout(failSafeRef.current);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  return { eventSourceRef, lastEventAtRef, connectionState, connectEvents };
}

/**
 * Classify quiet periods separately from transport failures. A slow model is
 * normal product state, not an error: only a disconnected EventSource should
 * receive warning emphasis. Heartbeat comments don't fire onmessage, so idle
 * time continues to measure meaningful progress rather than connection noise.
 */
export function classifyRunProgress(
  idleSeconds: number,
  phase: AgentPhase,
  connection: RunProgressState["connection"],
): RunProgressState {
  const toolRun = phase?.kind === "running_tools";
  const delayedAfter = toolRun ? 180 : 90;
  const stalledAfter = toolRun ? 300 : 180;
  const attention = idleSeconds >= stalledAfter
    ? "stalled"
    : idleSeconds >= delayedAfter
      ? "delayed"
      : "normal";
  return { idleSeconds, attention, connection };
}

export function useRunProgress(
  agentRunning: boolean,
  agentPhaseRef: React.RefObject<AgentPhase>,
  lastEventAtRef: React.RefObject<number>,
  connectionState: RunProgressState["connection"],
) {
  const [runProgress, setRunProgress] = useState<RunProgressState>(HEALTHY_PROGRESS);

  useEffect(() => {
    if (!agentRunning) {
      setRunProgress(HEALTHY_PROGRESS);
      return;
    }
    const update = () => {
      const idle = Math.max(0, Math.floor((Date.now() - lastEventAtRef.current) / 1000));
      setRunProgress(classifyRunProgress(idle, agentPhaseRef.current, connectionState));
    };
    update();
    const id = setInterval(() => {
      update();
    }, 5000);
    return () => clearInterval(id);
  }, [agentRunning, agentPhaseRef, connectionState, lastEventAtRef]);

  const resetRunProgress = useCallback(() => {
    setRunProgress(HEALTHY_PROGRESS);
  }, []);

  return { runProgress, resetRunProgress };
}
