"use client";
import { useEffect, useRef, type RefObject } from "react";

/** Dismiss a modeless, body-portalled panel without trapping the rest of the app. */
export function useDismissiblePanel(
  open: boolean,
  panel: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const node = panel.current;
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusBack = () => {
      const fallback = returnFocus?.current;
      const control = fallback?.matches("button") ? fallback : fallback?.querySelector<HTMLElement>("button");
      const target = control?.isConnected && control.getClientRects().length ? control
        : launcher?.isConnected && launcher.tabIndex >= 0 ? launcher : null;
      target?.focus();
    };
    const frame = requestAnimationFrame(() => panel.current?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (panel.current?.contains(target) || returnFocus?.current?.contains(target)
        || target.closest('[data-top-panel-trigger]')) return;
      closeRef.current();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A blocking child dialog owns its Escape handling.
      if (document.querySelector('[data-dialog-root] [aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      focusBack();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown);
      if (node?.contains(document.activeElement)) focusBack();
    };
  }, [open, panel, returnFocus]);
}
