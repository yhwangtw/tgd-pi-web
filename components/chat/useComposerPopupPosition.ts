"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/** Keep the small selector menus beside their icons, inside the viewport. */
export function useComposerPopupPosition(open: boolean, triggerRef: RefObject<HTMLButtonElement | null>) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || !trigger || !panel) return;
    const update = () => {
      const anchor = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      panel.style.position = "fixed";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.minWidth = `${Math.min(180, width - 16)}px`;
      panel.style.maxWidth = `${Math.max(0, width - 16)}px`;
      const above = anchor.top - top - 16;
      const below = top + height - anchor.bottom - 16;
      const useAbove = above >= Math.min(panel.scrollHeight, 240) || above >= below;
      panel.style.maxHeight = `${Math.max(0, useAbove ? above : below)}px`;
      const box = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(left + 8, Math.min(anchor.left, left + width - box.width - 8))}px`;
      panel.style.top = `${useAbove ? anchor.top - box.height - 8 : anchor.bottom + 8}px`;
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    for (let node: HTMLElement | null = trigger; node; node = node.parentElement) observer?.observe(node);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, triggerRef]);
  return panelRef;
}
