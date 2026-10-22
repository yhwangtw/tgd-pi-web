"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AT_BOTTOM,
  loadScrollPosition,
  loadTranscriptHistoryStart,
  saveTranscriptHistoryStart,
  type TranscriptHistoryKey,
} from "@/lib/scroll-memory";

interface Options {
  /** Full logical display order; refs and navigation retain these global indices. */
  visibleKeys: readonly TranscriptHistoryKey[];
  sessionKey?: string | null;
  /** The active turn must remain complete even when it exceeds one page. */
  currentTurnStartIndex?: number;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  pageSize?: number;
}

interface Range {
  sessionKey: string | null;
  firstKey: TranscriptHistoryKey;
  index: number;
}

interface Anchor {
  container: HTMLDivElement;
  element: HTMLDivElement | null;
  top: number;
  overflowAnchor: string;
  sessionKey: string | null;
  targetKey: TranscriptHistoryKey;
  targetIndex: number;
  awaitingCommit: boolean;
}

/**
 * Mount recent history first, then retain every range the reader reveals.
 * This bounds the initial DOM, rather than recycling rows or guessing heights.
 */
export function useTranscriptHistory({
  visibleKeys,
  sessionKey: inputSessionKey,
  currentTurnStartIndex,
  scrollContainerRef,
  messageRefs,
  pageSize: requestedPageSize = 200,
}: Options) {
  const sessionKey = inputSessionKey ?? null;
  const pageSize = Math.max(1, Math.floor(requestedPageSize) || 200);
  const [range, setRange] = useState<Range | null>(null);
  const isPrependingRef = useRef(false);
  const anchorRef = useRef<Anchor | null>(null);
  const framesRef = useRef<number[]>([]);

  // Resolve on the first nonempty render, before mounting any history. Data
  // normally arrives after the hook's initial empty render.
  const resolvedRange = useMemo((): Range | null => {
    if (visibleKeys.length === 0) return null;
    let start: number;
    if (range?.sessionKey === sessionKey) {
      const retained = visibleKeys[range.index] === range.firstKey
        ? range.index
        : visibleKeys.indexOf(range.firstKey);
      if (retained >= 0) start = retained;
      else start = Math.max(0, visibleKeys.length - pageSize);
    } else {
      const savedKey = loadTranscriptHistoryStart(sessionKey);
      const savedIndex = savedKey === undefined ? -1 : visibleKeys.indexOf(savedKey);
      const savedPosition = loadScrollPosition(sessionKey);
      if (savedIndex >= 0) start = savedIndex;
      // Legacy pixel offsets refer to the full transcript. Keep that layout
      // for their first restore instead of interpreting them against a suffix.
      else if (savedKey === undefined && savedPosition !== undefined && savedPosition !== AT_BOTTOM) start = 0;
      else start = Math.max(0, visibleKeys.length - pageSize);
    }
    if (currentTurnStartIndex !== undefined && Number.isFinite(currentTurnStartIndex)) {
      start = Math.min(start, Math.max(0, Math.floor(currentTurnStartIndex)));
    }
    const firstKey = visibleKeys[start];
    if (range?.sessionKey === sessionKey && range.index === start && range.firstKey === firstKey) return range;
    return { sessionKey, firstKey, index: start };
  }, [visibleKeys, sessionKey, currentTurnStartIndex, pageSize, range]);
  const startIndex = resolvedRange?.index ?? 0;

  useLayoutEffect(() => {
    if (resolvedRange !== range) setRange(resolvedRange);
  }, [resolvedRange, range]);

  const firstKey = resolvedRange?.firstKey;
  useEffect(() => {
    if (firstKey !== undefined) saveTranscriptHistoryStart(sessionKey, firstKey);
  }, [sessionKey, firstKey]);

  const finishPrepend = useCallback(() => {
    framesRef.current.forEach(frame => cancelAnimationFrame(frame));
    framesRef.current = [];
    const anchor = anchorRef.current;
    if (anchor) anchor.container.style.overflowAnchor = anchor.overflowAnchor;
    anchorRef.current = null;
    isPrependingRef.current = false;
  }, []);

  useEffect(() => finishPrepend, [sessionKey, finishPrepend]);

  const reveal = useCallback((index: number): boolean => {
    if (!resolvedRange || !Number.isFinite(index)) return false;
    const target = Math.max(0, Math.floor(index));
    const pendingStart = anchorRef.current?.awaitingCommit
      ? visibleKeys.indexOf(anchorRef.current.targetKey)
      : -1;
    if (target >= (pendingStart < 0 ? startIndex : Math.min(startIndex, pendingStart))) return false;
    const container = scrollContainerRef.current;
    const targetKey = visibleKeys[target];
    if (!anchorRef.current && container) {
      const bounds = container.getBoundingClientRect();
      let first: HTMLDivElement | null = null;
      let anchorElement: HTMLDivElement | null = null;
      for (let i = startIndex; i < visibleKeys.length; i++) {
        const element = messageRefs.current[i];
        if (!element?.isConnected) continue;
        first ??= element;
        const rect = element.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
          anchorElement = element;
          break;
        }
      }
      anchorElement ??= first;
      anchorRef.current = {
        container,
        element: anchorElement,
        top: anchorElement?.getBoundingClientRect().top ?? 0,
        overflowAnchor: container.style.overflowAnchor,
        sessionKey,
        targetKey,
        targetIndex: target,
        awaitingCommit: true,
      };
      // Browser anchoring and manual row compensation must not both run.
      container.style.overflowAnchor = "none";
    } else if (anchorRef.current) {
      anchorRef.current.targetKey = targetKey;
      anchorRef.current.targetIndex = target;
      anchorRef.current.awaitingCommit = true;
    }
    isPrependingRef.current = true;
    setRange({ sessionKey, firstKey: targetKey, index: target });
    return true;
  }, [resolvedRange, startIndex, scrollContainerRef, visibleKeys, messageRefs, sessionKey]);

  const loadPrevious = useCallback((): boolean => {
    if (isPrependingRef.current) return false;
    return reveal(Math.max(0, startIndex - pageSize));
  }, [reveal, startIndex, pageSize]);

  useLayoutEffect(() => {
    if (!isPrependingRef.current) return;
    const anchor = anchorRef.current;
    const targetIndex = anchor
      ? (visibleKeys[anchor.targetIndex] === anchor.targetKey ? anchor.targetIndex : visibleKeys.indexOf(anchor.targetKey))
      : -1;
    if (anchor && (anchor.sessionKey !== sessionKey || targetIndex < 0)) {
      finishPrepend();
      return;
    }
    if (anchor?.awaitingCommit) {
      if (startIndex > targetIndex) return;
      anchor.awaitingCommit = false;
      if (anchor.element?.isConnected && scrollContainerRef.current === anchor.container) {
        anchor.container.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
      }
    }
    if (framesRef.current.length > 0) return;
    // Leave one complete observer/frame cycle for the caller to suppress
    // tail following and rebase its new-output counter after the prepend.
    framesRef.current.forEach(frame => cancelAnimationFrame(frame));
    const firstFrame = requestAnimationFrame(() => {
      framesRef.current = [requestAnimationFrame(finishPrepend)];
    });
    framesRef.current = [firstFrame];
  }, [startIndex, sessionKey, visibleKeys, finishPrepend, scrollContainerRef]);

  return { startIndex, hasPrevious: startIndex > 0, loadPrevious, reveal, isPrependingRef };
}
