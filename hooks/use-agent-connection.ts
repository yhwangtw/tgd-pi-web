"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { AgentEvent, AgentPhase, RunProgressState } from "./use-agent-session-types";

const HEALTHY_PROGRESS: RunProgressState = {
  idleSeconds: 0,
  attention: "normal",
  connection: "connected",
};

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
  const [mountedAt] = useState(() => Date.now());
  const lastEventAtRef = useRef(mountedAt);
  const reconnectAttemptRef = useRef(0);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const [connectionState, setConnectionState] = useState<RunProgressState["connection"]>("connected");

  // Resolves `true` once the stream to `sid` is open, `false` when it isn't
  // yet (failsafe timeout / connect error) — a broken stream never blocks the
  // caller, but it can tell the difference and log it.
  const connectEvents = useCallback((sid: string): Promise<boolean> => {
    const url = `/api/agent/${encodeURIComponent(sid)}/events`;
    const current = eventSourceRef.current;
    // Already connected (or connecting) to this session — reuse instead of
    // tearing down (a recreate right before a prompt POST could drop the
    // run's first events).
    if (current && current.url.endsWith(url)) {
      if (current.readyState === EventSource.OPEN) return Promise.resolve(true);
      if (current.readyState === EventSource.CONNECTING) {
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(failSafe); resolve(ok); } };
          const failSafe = setTimeout(() => settle(false), 1_500);
          current.addEventListener("open", () => settle(true), { once: true });
          current.addEventListener("error", () => settle(false), { once: true });
        });
      }
    }
    if (current) {
      current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(url);
    eventSourceRef.current = es;
    // Resolves when the stream is open, so callers can await the connection
    // BEFORE prompting — otherwise the run's first events race the subscribe.
    // A safety-net timeout keeps a broken stream from ever blocking a send.
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const failSafe = setTimeout(() => settle(false), 1_500);
      es.onopen = () => {
        reconnectAttemptRef.current = 0;
        reconnectStartedAtRef.current = null;
        setConnectionState("connected");
        clearTimeout(failSafe);
        settle(true);
      };
      es.onmessage = (e) => {
        lastEventAtRef.current = Date.now();
        // Promote/demote immediately on real progress instead of waiting up to
        // five seconds for the polling interval to clear delayed UI.
        setConnectionState("connected");
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        settle(false); // no-op after open — only fails a still-pending await
        if (eventSourceRef.current === es && agentRunningRef.current) {
          if (reconnectStartedAtRef.current === null) reconnectStartedAtRef.current = Date.now();
          const reconnectingFor = Date.now() - reconnectStartedAtRef.current;
          // Mobile radios and browsers routinely blip during network changes.
          // Keep the first two attempts visually quiet; promote only a
          // sustained transport problem, separate from model latency.
          if (reconnectAttemptRef.current >= 2 || reconnectingFor >= 10_000) {
            setConnectionState("reconnecting");
          }
          es.close();
          eventSourceRef.current = null;
          // Exponential backoff: 1s, 2s, 4s, ... capped at 15s, so a downed
          // server isn't hammered once per second.
          const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 15_000);
          reconnectAttemptRef.current++;
          setTimeout(() => {
            if (agentRunningRef.current) void connectEvents(sid);
          }, delay);
        }
      };
    });
  }, [agentRunningRef, handleAgentEventRef]);

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
