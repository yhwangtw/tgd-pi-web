"use client";
import { useEffect, type RefObject } from "react";

/** Keyboard behavior shared by the two portalled app menus. */
export function usePopupMenuKeyboard(open: boolean, panel: RefObject<HTMLElement | null>, anchor: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const launcher = anchor.current?.querySelector<HTMLElement>("button") ?? document.activeElement as HTMLElement | null;
    const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const frame = requestAnimationFrame(() => items()[0]?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close(); launcher?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && panel.current?.contains(document.activeElement)) {
        event.preventDefault();
        const entries = items();
        const at = entries.indexOf(document.activeElement as HTMLElement);
        entries[event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length]?.focus();
      } else if (event.key === "Tab") close();
    };
    document.addEventListener("keydown", keydown, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown, true); };
  }, [open, panel, anchor, close]);
}
