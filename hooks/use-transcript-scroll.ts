"use client";

import { useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { getScrollFollowMode } from "@/lib/prefs";
import { motionScrollBehavior } from "@/lib/motion";
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
  // scrollTop can be fractional while the height measurements are rounded.
  // Retiring filler may only shrink it: a subpixel overshoot must not grow it
  // by 1px on every layout effect and trigger a synchronous render loop.
  return Math.min(currentSpacerHeight, Math.max(0, Math.ceil(scrollTop + clientHeight - contentHeight)));
}

/**
 * Whether the real transcript tail is meaningfully below the viewport.
 *
 * This deliberately uses marker geometry instead of scrollHeight: an active
 * run adds a spacer after the marker so a sent message can be anchored in the
 * upper reading area. Counting that spacer makes the "Latest" affordance
 * appear even while the newest real content is still visible.
 */
export function isTranscriptTailOutOfView(
  markerTop: number,
  containerBottom: number,
  revealDistance = 96,
): boolean {
  return markerTop > containerBottom + revealDistance;
}

/**
 * Transcript scroll management: owns the anchor refs and decides when the
 * view follows new content — initial jump to bottom, revealing a sent message,
 * and conditional follow at end of a run.
 */
export function useTranscriptScroll(
  messagesLength: number,
  agentRunning: boolean,
  agentRunningRef: React.RefObject<boolean>,
  /** Session id — enables per-session scroll restore across switches. */
  memoryKey?: string | null,
  streamingOutput = false,
) {
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sentMessageScrollRef = useRef({ settling: false, scrollTop: null as number | null });
  const latestOutputRef = useRef({ messagesLength, streamingOutput });
  useLayoutEffect(() => { latestOutputRef.current = { messagesLength, streamingOutput }; }, [messagesLength, streamingOutput]);
  const cancelSendSettleRef = useRef<(() => void) | null>(null);
  const viewportAnchorRef = useRef<{ messagesLength: number; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    const anchor = viewportAnchorRef.current;
    // Let the bounded frame pass handle a fast reply; afterward, viewport
    // correction belongs only to this send while awaiting its first output.
    if (anchor && !sentMessageScrollRef.current.settling
      && (streamingOutput || messagesLength > anchor.messagesLength || !agentRunning)) anchor.stop();
  }, [messagesLength, streamingOutput, agentRunning]);
  useEffect(() => () => cancelSendSettleRef.current?.(), [memoryKey]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior: motionScrollBehavior(behavior), block: "end" });
  }, []);

  const revealSentMessage = useCallback(() => {
    const container = scrollContainerRef.current;
    const message = lastUserMsgRef.current;
    if (!container || !message || container.clientHeight <= 0) return;
    const viewport = container.getBoundingClientRect();
    const bounds = message.getBoundingClientRect();
    const height = container.clientHeight;
    const margin = Math.min(16, height / 4);
    const relativeTop = bounds.top - viewport.top;
    const absoluteTop = relativeTop + container.scrollTop;
    let top: number;

    if (getScrollFollowMode() === "preserve") {
      // Move only enough to reveal the sent message. For an oversized prompt,
      // reveal its beginning rather than jumping to the end of the text.
      if (bounds.height > height - 2 * margin) {
        if (relativeTop >= margin && relativeTop < height - margin) return;
        top = absoluteTop - margin;
      } else if (relativeTop < margin) {
        top = absoluteTop - margin;
      } else if (relativeTop + bounds.height > height - margin) {
        top = absoluteTop + bounds.height - height + margin;
      } else {
        return;
      }
    } else {
      // Leave some previous context above a short prompt. Taller messages get
      // more room, and prompts larger than the viewport start near its top.
      const offset = Math.max(margin, Math.min(height / 4, height - bounds.height - margin));
      top = absoluteTop - offset;
    }
    top = Math.max(0, top);
    // Immediate anchoring lets completion preserve the correct reading position
    // even when a reply finishes before a smooth animation would have settled.
    if (Math.abs(top - container.scrollTop) > 1) {
      container.scrollTo({ top, behavior: "auto" });
      sentMessageScrollRef.current.scrollTop = container.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    if (messagesLength > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        cancelSendSettleRef.current?.();
        sentMessageScrollRef.current.settling = true;
        revealSentMessage();
        // Previous turns, the cleared composer and Latest can change layout in
        // nested commits. Settle across two stable frames (at most four total),
        // yielding immediately to any reader input.
        const container = scrollContainerRef.current;
        const message = lastUserMsgRef.current;
        if (container && message) {
          let cancelled = false;
          let frame = 0;
          let passes = 0;
          let previous: { height: number; messageTop: number } | null = null;
          let viewportHeight = container.clientHeight;
          let observer: ResizeObserver | null = null;
          const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
          const cleanup = (keepScrollTarget = false) => {
            cancelled = true;
            cancelAnimationFrame(frame);
            observer?.disconnect();
            if (viewportAnchorRef.current?.stop === stopViewportAnchor) viewportAnchorRef.current = null;
            events.forEach(event => document.removeEventListener(event, cancel, true));
            sentMessageScrollRef.current.settling = false;
            sentMessageScrollRef.current.scrollTop = keepScrollTarget ? container.scrollTop : null;
            if (cancelSendSettleRef.current === cancel) cancelSendSettleRef.current = null;
          };
          const cancel = () => cleanup();
          const stopViewportAnchor = () => cleanup(true);
          const settle = () => {
            if (cancelled || scrollContainerRef.current !== container || lastUserMsgRef.current !== message) {
              cleanup();
              return;
            }
            revealSentMessage();
            const mode = getScrollFollowMode();
            const output = latestOutputRef.current;
            const hasReply = output.streamingOutput || output.messagesLength > messagesLength;
            if (mode !== "preserve" && (hasReply || mode === "always")
              && messagesEndRef.current && messagesEndRef.current.getBoundingClientRect().top > container.getBoundingClientRect().bottom) {
              scrollToBottom("auto");
            }
            const next = { height: container.clientHeight,
              messageTop: message.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop };
            const stable = previous && Math.abs(previous.height - next.height) <= 1 && Math.abs(previous.messageTop - next.messageTop) <= 1;
            previous = next;
            if (++passes < 4 && !stable) frame = requestAnimationFrame(settle);
            else {
              sentMessageScrollRef.current.settling = false;
              sentMessageScrollRef.current.scrollTop = container.scrollTop;
              if (hasReply || mode === "preserve" || !agentRunningRef.current) cleanup(true);
            }
          };
          // A monitor/composer may resize after those frames have settled.
          // Observe only viewport height, never growing transcript content,
          // and yield permanently to reader input or the first reply.
          if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(() => {
              if (cancelled || scrollContainerRef.current !== container || lastUserMsgRef.current !== message) return;
              const height = container.clientHeight;
              if (Math.abs(height - viewportHeight) <= 1) return;
              viewportHeight = height;
              const output = latestOutputRef.current;
              if (output.streamingOutput || output.messagesLength > messagesLength || getScrollFollowMode() === "preserve") {
                cleanup(true);
                return;
              }
              revealSentMessage();
            });
            observer.observe(container);
          }
          viewportAnchorRef.current = { messagesLength, stop: stopViewportAnchor };
          frame = requestAnimationFrame(settle);
          cancelSendSettleRef.current = cancel;
          events.forEach(event => document.addEventListener(event, cancel, { passive: true, capture: true }));
        } else {
          sentMessageScrollRef.current.settling = false;
        }
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        // Restore where this session was left (unless the reader was at the
        // tail — then keep the follow-the-bottom behavior for new content).
        const saved = loadScrollPosition(memoryKey);
        const container = scrollContainerRef.current;
        if (saved !== undefined && saved !== AT_BOTTOM && container) {
          // Fonts and async message content may not be laid out yet — a single
          // assignment can clamp to a smaller scrollHeight. Re-apply after
          // layout settles.
          container.scrollTop = saved;
          let cancelled = false;
          const cancel = () => { cancelled = true; };
          const apply = () => {
            if (!cancelled && scrollContainerRef.current === container) container.scrollTop = saved;
          };
          const frame = requestAnimationFrame(apply);
          const timer = setTimeout(apply, 80);
          const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
          // Dock and navigation controls are outside the transcript; their
          // explicit navigation must also win over a pending initial restore.
          events.forEach((event) => document.addEventListener(event, cancel, { passive: true, capture: true }));
          return () => {
            cancel(); cancelAnimationFrame(frame); clearTimeout(timer);
            events.forEach((event) => document.removeEventListener(event, cancel, true));
          };
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
  }, [messagesLength, agentRunning, agentRunningRef, scrollToBottom, revealSentMessage, memoryKey]);

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
        messagesEndRef.current
          ? messagesEndRef.current.getBoundingClientRect().top - container.getBoundingClientRect().bottom
          : container.scrollHeight - container.scrollTop - container.clientHeight,
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
    messagesEndRef, scrollContainerRef, sentMessageScrollRef,
    scrollToBottom, revealSentMessage,
  };
}
