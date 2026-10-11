"use client";

import { useState, useCallback } from "react";

/**
 * Right panel width: draggable splitter, persisted in localStorage.
 * `rightWidth === null` means "use the CSS default (38%)".
 */
export function useRightPanelWidth() {
  const [rightWidth, setRightWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const v = parseInt(localStorage.getItem("pi-right-width") ?? "", 10);
      return Number.isFinite(v) && v >= 320 ? v : null;
    } catch {
      return null;
    }
  });
  const [draggingRight, setDraggingRight] = useState(false);

  const startRightResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingRight(true);
    // Track the latest width in a local so we can persist it *synchronously*
    // on mouseup (not inside a state-updater, which lands a tick late and
    // races the double-click reset). Persist only if the pointer actually
    // moved, so a plain click / the clicks of a double-click never re-save.
    let latest: number | null = null;
    const onMove = (ev: MouseEvent) => {
      const max = window.innerWidth - 500;
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 320), max);
      latest = w;
      setRightWidth(w);
    };
    const onUp = () => {
      setDraggingRight(false);
      if (latest != null) {
        try { localStorage.setItem("pi-right-width", String(latest)); } catch { /* ignore */ }
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const resetRightWidth = useCallback(() => {
    setRightWidth(null);
    try { localStorage.removeItem("pi-right-width"); } catch { /* ignore */ }
  }, []);

  const resizeRightByKeyboard = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Home" || event.key === "Enter") {
      event.preventDefault();
      resetRightWidth();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = event.currentTarget.parentElement?.getBoundingClientRect().width ?? window.innerWidth * 0.38;
    const step = event.shiftKey ? 80 : 24;
    const max = Math.max(320, window.innerWidth - 500);
    const next = Math.min(max, Math.max(320, current + (event.key === "ArrowLeft" ? step : -step)));
    setRightWidth(next);
    try { localStorage.setItem("pi-right-width", String(next)); } catch { /* ignore */ }
  }, [resetRightWidth]);

  return { rightWidth, draggingRight, startRightResize, resetRightWidth, resizeRightByKeyboard };
}
