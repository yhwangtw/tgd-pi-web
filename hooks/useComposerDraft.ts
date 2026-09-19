"use client";

import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { loadDraft, saveDraft } from "@/lib/composer-persistence";

export function useComposerDraft(key: string | null) {
  const [value, renderValue] = useState("");
  const current = useRef({ key, value: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    saveDraft(current.current.key, current.current.value);
  }, []);
  useLayoutEffect(() => {
    current.current = { key, value: loadDraft(key) };
    renderValue(current.current.value);
    window.addEventListener("pagehide", flush);
    return () => { flush(); window.removeEventListener("pagehide", flush); };
  }, [key, flush]);
  const setValue = useCallback((next: SetStateAction<string>) => {
    if (current.current.key !== key) return;
    const updated = typeof next === "function" ? next(current.current.value) : next;
    current.current.value = updated;
    renderValue(updated);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [key, flush]);
  return [value, setValue] as const;
}
