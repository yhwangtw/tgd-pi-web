"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { AgentMessage } from "@/lib/types";
import { markSessionRead } from "@/lib/session-read-state";

export const READ_DWELL_MS = 600;
interface Options {
  sessionId: string | null;
  ready: boolean;
  streaming: boolean;
  containerRef: RefObject<HTMLElement | null>;
  messageRefs: RefObject<(HTMLElement | null)[]>;
  displayIndices: number[];
  entryIds: string[];
  messages: AgentMessage[];
}

export function visibleReadCandidate(options: Options): { entryId: string; timestamp: number } | null {
  const container = options.containerRef.current;
  if (!container || document.visibilityState === "hidden" || !document.hasFocus()) return null;
  for (const modal of document.querySelectorAll('[aria-modal="true"], dialog[open]')) {
    if (modal.getClientRects().length && !modal.contains(container)) return null;
  }
  const box = container.getBoundingClientRect();
  const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
  if (bottom <= top) return null;
  for (let i = options.displayIndices.length - 1; i >= 0; i--) {
    const index = options.displayIndices[i];
    const message = options.messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    if (options.streaming && index === options.messages.length - 1 && message.role === "assistant") continue;
    const entryId = options.entryIds[index];
    const element = options.messageRefs.current[i];
    if (!element || !entryId || !Number.isFinite(message.timestamp)) continue;
    const rect = element.getBoundingClientRect();
    // Reaching the bottom of a tall message counts; offscreen earlier messages do not.
    if (rect.height <= 0 || rect.bottom <= top || rect.top >= bottom || rect.bottom > bottom + 1) continue;
    const left = Math.max(0, box.left, rect.left), right = Math.min(innerWidth, box.right, rect.right);
    if (right <= left) continue;
    const hit = document.elementFromPoint((left + right) / 2, Math.min(bottom - 1, rect.bottom - 1));
    if (!hit || !element.contains(hit)) continue;
    return { entryId, timestamp: message.timestamp! };
  }
  return null;
}

/** A stable, unobscured foreground view must dwell before advancing its cursor. */
export function useSessionReadTracking(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const { sessionId, ready, containerRef } = options;
  useEffect(() => {
    const container = containerRef.current;
    if (!sessionId || !ready || !container) return;
    let candidate: ReturnType<typeof visibleReadCandidate> = null;
    let since = 0;
    let recorded = "";
    const reset = () => { candidate = null; since = 0; };
    const tick = () => {
      const next = visibleReadCandidate(latest.current);
      if (!next) { reset(); return; }
      if (candidate?.entryId !== next.entryId || candidate.timestamp !== next.timestamp) {
        candidate = next; since = performance.now(); return;
      }
      const key = `${next.entryId}:${next.timestamp}`;
      if (performance.now() - since >= READ_DWELL_MS && recorded !== key) {
        markSessionRead(sessionId, next.timestamp, next.entryId, latest.current.entryIds);
        recorded = key;
      }
    };
    // Sampling catches overlays opening/closing without observing the entire DOM.
    const timer = setInterval(tick, 200);
    container.addEventListener("scroll", reset, { passive: true });
    window.addEventListener("blur", reset);
    window.addEventListener("focus", reset);
    window.addEventListener("resize", reset);
    document.addEventListener("visibilitychange", reset);
    tick();
    return () => {
      clearInterval(timer);
      container.removeEventListener("scroll", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("focus", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", reset);
      // Never mark a message merely because the user switched away or closed the tab.
    };
  }, [sessionId, ready, containerRef]);
}
