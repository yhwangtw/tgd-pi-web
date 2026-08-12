"use client";

import { useRef, useCallback, useEffect } from "react";
import { getScrollFollowMode } from "@/lib/prefs";
import { AT_BOTTOM, loadScrollPosition, saveScrollPosition } from "@/lib/scroll-memory";

/**
 * Minimum bottom filler needed to keep the current viewport offset valid when
 * the full-height run spacer is retired. Without it, the browser clamps
 * scrollTop to the new maximum and visually yanks an anchored reader down.
 */
export function preservedRunSpacerHeight(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  currentSpacerHeight: number,
): number {
  const contentHeight = Math.max(0, scrollHeight - currentSpacerHeight);
  return Math.max(0, Math.ceil(scrollTop + clientHeight - contentHeight));
}

/**
 * Transcript scroll management: owns the anchor refs and decides when the
 * view follows new content — initial jump to bottom, scroll-sent-message-
 * to-top, and conditional follow at end of a run.
 */
export function useTranscriptScroll(
  messagesLength: number,
  agentRunning: boolean,
  agentRunningRef: React.RefObject<boolean>,
  /** Session id — enables per-session scroll restore across switches. */
  memoryKey?: string | null,
) {
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    // This must be immediate. A short response can finish before a smooth
    // animation reaches the anchor; the end-of-run spacer calculation would
    // then preserve the old near-bottom position instead of the sent message.
    container.scrollTo({ top: elAbsTop - 16, behavior: "auto" });
  }, []);

  useEffect(() => {
    if (messagesLength > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        // Restore where this session was left (unless the reader was at the
        // tail — then keep the follow-the-bottom behavior for new content).
        const saved = loadScrollPosition(memoryKey);
        const container = scrollContainerRef.current;
        if (saved !== undefined && saved !== AT_BOTTOM && container) {
          // Content may not be laid out yet (content-visibility) — a single
          // assignment can clamp to a smaller scrollHeight. Re-apply after
          // layout settles.
          container.scrollTop = saved;
          requestAnimationFrame(() => {
            const c = scrollContainerRef.current;
            if (c) c.scrollTop = saved;
          });
          setTimeout(() => {
            const c = scrollContainerRef.current;
            if (c && Math.abs(c.scrollTop - saved) > 4) c.scrollTop = saved;
          }, 80);
        } else {
          scrollToBottom("instant");
        }
      } else if (!agentRunningRef.current && getScrollFollowMode() === "always") {
        // Do not infer follow intent from distance after a run. The temporary
        // run spacer has already unmounted by this point, so the browser may
        // clamp scrollTop to the new maximum and make `dist` look like zero
        // even when the reader was anchored at the sent message. Streaming
        // follow already keeps an engaged reader at the tail; only the
        // explicit always-follow preference should move an idle reader here.
        scrollToBottom("smooth");
      }
    }
  }, [messagesLength, agentRunning, agentRunningRef, scrollToBottom, scrollUserMsgToTop, memoryKey]);

  // Record the position (throttled) so switching away and back restores it.
  const hasMessages = messagesLength > 0;
  useEffect(() => {
    if (!memoryKey) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    let ticking = false;
    const record = () => {
      ticking = false;
      // A detached container reads 0/0/0 — dist 0 would masquerade as
      // "at bottom" and clobber the real position saved while scrolling.
      if (!container.isConnected || container.scrollHeight === 0) return;
      saveScrollPosition(
        memoryKey,
        container.scrollTop,
        container.scrollHeight - container.scrollTop - container.clientHeight,
      );
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(record);
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      record(); // final write on unmount (session switch)
    };
  }, [memoryKey, hasMessages]);

  return {
    initialScrollDoneRef, lastUserMsgRef, pendingScrollToUserRef,
    messagesEndRef, scrollContainerRef,
    scrollToBottom, scrollUserMsgToTop,
  };
}
