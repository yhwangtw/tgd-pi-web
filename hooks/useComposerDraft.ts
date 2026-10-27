"use client";

import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { clearDraft, loadDraft, saveDraft } from "@/lib/composer-persistence";

// In-memory fallback makes a handoff lossless even when localStorage rejects a
// large draft or is unavailable; it survives component/session switches.
const handoffs = new Map<string, string>();
function saveDraftSafely(key: string | null, value: string) {
  saveDraft(key, value);
  if (!key) return;
  if (loadDraft(key) === value) handoffs.delete(key); else handoffs.set(key, value);
}
const liveDrafts = new Map<string, { read: () => string; clear: () => void }>();

/** Preserve typing done while a new conversation's first send is being accepted. */
export function transferComposerDraft(from: string, to: string, submittedDraft?: string) {
  if (from === to) return;
  const live = liveDrafts.get(from);
  const text = live?.read() ?? handoffs.get(from) ?? loadDraft(from);
  if (text && text !== submittedDraft) {
    const existing = handoffs.get(to) ?? loadDraft(to);
    saveDraftSafely(to, existing ? `${existing}\n\n${text}` : text);
  }
  live?.clear();
  clearDraft(from);
  handoffs.delete(from);
}

export function useComposerDraft(key: string | null) {
  const [value, renderValue] = useState("");
  const current = useRef({ key, value: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    saveDraftSafely(current.current.key, current.current.value);
  }, []);
  useLayoutEffect(() => {
    current.current = { key, value: (key ? handoffs.get(key) : undefined) ?? loadDraft(key) };
    renderValue(current.current.value);
    const live = { read: () => current.current.value, clear: () => {
      clearTimeout(timer.current);
      current.current.value = "";
      renderValue("");
    } };
    if (key) liveDrafts.set(key, live);
    window.addEventListener("pagehide", flush);
    return () => {
      flush(); window.removeEventListener("pagehide", flush);
      if (key && liveDrafts.get(key) === live) liveDrafts.delete(key);
    };
  }, [key, flush]);
  const setValue = useCallback((next: SetStateAction<string>) => {
    if (current.current.key !== key) return;
    const updated = typeof next === "function" ? next(current.current.value) : next;
    current.current.value = updated;
    renderValue(updated);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [key, flush]);
  const readValue = useCallback(() => current.current.key === key ? current.current.value : undefined, [key]);
  return [value, setValue, readValue] as const;
}
