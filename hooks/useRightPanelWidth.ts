"use client";

import { useState, useCallback, useRef, useLayoutEffect, useEffect } from "react";

type Limits = { min: number; max: number; right: number; width: number };
const clamp = (width: number, limits: Limits) => Math.round(Math.min(limits.max, Math.max(limits.min, width)));

/** Keep the preferred width, but fit the actual space left beside the chat. */
export function useRightPanelWidth() {
  const panelRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<((commit: boolean, update?: boolean) => void) | null>(null);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(() => {
    try {
      const value = Number(localStorage.getItem("pi-right-width"));
      return Number.isFinite(value) && value >= 160 ? value : null;
    } catch { return null; }
  });
  const [limits, setLimits] = useState<Limits>({ min: 320, max: 100000, right: 0, width: 0 });
  const [draggingRight, setDraggingRight] = useState(false);

  const measure = useCallback((): Limits => {
    const panel = panelRef.current;
    const parent = panel?.parentElement;
    const center = panel?.previousElementSibling;
    const parentBox = parent?.getBoundingClientRect();
    const centerBox = center?.getBoundingClientRect();
    const margin = panel ? parseFloat(getComputedStyle(panel).marginRight) || 0 : 0;
    const padding = parent ? parseFloat(getComputedStyle(parent).paddingRight) || 0 : 0;
    const right = parentBox?.width ? parentBox.right - padding - margin : window.innerWidth;
    const available = Math.max(0, right - (centerBox?.left ?? 0));
    const min = Math.min(320, Math.max(160, available * 0.6));
    const max = Math.max(min, available - (window.innerWidth <= 1024 ? 280 : 360));
    return { min: Math.round(min), max: Math.round(max), right, width: Math.round(panel?.getBoundingClientRect().width ?? 0) };
  }, []);

  useLayoutEffect(() => {
    const update = () => {
      const next = measure();
      setLimits(previous => previous.min === next.min && previous.max === next.max && previous.right === next.right && previous.width === next.width ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    const parent = panelRef.current?.parentElement;
    if (parent) {
      observer?.observe(parent);
      for (const child of parent.children) observer?.observe(child);
    }
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [measure]);

  useEffect(() => () => cleanupRef.current?.(false, false), []);

  const startRightResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || cleanupRef.current) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const before = preferredWidth;
    let latest: number | null = null;
    setDraggingRight(true);
    const finish = (commit: boolean, update = true) => {
      if (cleanupRef.current !== finish) return;
      cleanupRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("pointerdown", otherPointer);
      window.removeEventListener("blur", blur);
      target.removeEventListener("lostpointercapture", lost);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      if (update) {
        setDraggingRight(false);
        if (!commit) setPreferredWidth(before);
      }
      if (commit && latest !== null) {
        try { localStorage.setItem("pi-right-width", String(latest)); } catch { /* ignore */ }
      }
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const bounds = measure();
      latest = clamp(bounds.right - next.clientX, bounds);
      setPreferredWidth(latest);
    };
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true); };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false); };
    const otherPointer = (next: PointerEvent) => { if (next.pointerId !== pointerId) finish(false); };
    const blur = () => finish(false);
    const lost = () => finish(false);
    cleanupRef.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("pointerdown", otherPointer);
    window.addEventListener("blur", blur);
    target.addEventListener("lostpointercapture", lost);
    target.setPointerCapture?.(pointerId);
  }, [measure, preferredWidth]);

  const resetRightWidth = useCallback(() => {
    cleanupRef.current?.(false);
    setPreferredWidth(null);
    try { localStorage.removeItem("pi-right-width"); } catch { /* ignore */ }
  }, []);

  const resizeRightByKeyboard = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Home" || event.key === "Enter") {
      event.preventDefault(); resetRightWidth(); return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = event.currentTarget.parentElement?.getBoundingClientRect().width ?? window.innerWidth * 0.38;
    const next = clamp(current + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 80 : 24), measure());
    setPreferredWidth(next);
    try { localStorage.setItem("pi-right-width", String(next)); } catch { /* ignore */ }
  }, [measure, resetRightWidth]);

  const rightWidth = preferredWidth === null ? null : clamp(preferredWidth, limits);
  return { panelRef, rightWidth, rightMeasuredWidth: limits.width, rightMinWidth: limits.min, rightMaxWidth: limits.max, draggingRight, startRightResize, resetRightWidth, resizeRightByKeyboard };
}
