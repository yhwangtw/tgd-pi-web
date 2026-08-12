"use client";

// ============================================================================
// Small persisted UI preferences that need to be readable from both React
// components and non-reactive code (e.g. the scroll logic in useAgentSession).
// ============================================================================

import { useSyncExternalStore } from "react";

const FOLLOW_MODE_KEY = "pi-scroll-follow-mode";
const LEGACY_FOLLOW_KEY = "pi-follow-stream";

export const SCROLL_FOLLOW_MODES = ["smart", "always", "preserve"] as const;
export type ScrollFollowMode = typeof SCROLL_FOLLOW_MODES[number];

const listeners = new Set<() => void>();
let cachedMode: ScrollFollowMode | null = null;

function isScrollFollowMode(value: string | null): value is ScrollFollowMode {
  return SCROLL_FOLLOW_MODES.includes(value as ScrollFollowMode);
}

function readMode(): ScrollFollowMode {
  if (typeof window === "undefined") return "smart";
  try {
    const stored = localStorage.getItem(FOLLOW_MODE_KEY);
    if (isScrollFollowMode(stored)) return stored;
    // Existing users who explicitly enabled the former boolean preference
    // keep terminal-style following. Everyone else receives the new smart
    // default without needing a migration write during initial render.
    if (localStorage.getItem(LEGACY_FOLLOW_KEY) === "1") return "always";
  } catch {
    // Storage unavailable — use the session default.
  }
  return "smart";
}

export function getScrollFollowMode(): ScrollFollowMode {
  cachedMode ??= readMode();
  return cachedMode;
}

export function setScrollFollowMode(mode: ScrollFollowMode): void {
  if (getScrollFollowMode() === mode) return;
  cachedMode = mode;
  try {
    localStorage.setItem(FOLLOW_MODE_KEY, mode);
    // The new enum is authoritative once the user makes a choice.
    localStorage.removeItem(LEGACY_FOLLOW_KEY);
  } catch {
    // Keep the in-memory preference for this tab.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useScrollFollowMode(): ScrollFollowMode {
  return useSyncExternalStore(subscribe, getScrollFollowMode, () => "smart");
}

/**
 * Compatibility helper for the former boolean preference. New UI should use
 * the explicit three-state mode above.
 */
export function getAlwaysFollow(): boolean {
  return getScrollFollowMode() === "always";
}

/** Flip the preference; returns the new value. */
export function toggleAlwaysFollow(): boolean {
  const next = !getAlwaysFollow();
  setScrollFollowMode(next ? "always" : "smart");
  return next;
}

/** Test/HMR helper: force the next read to observe persisted state. */
export function resetScrollFollowModeCache(): void {
  cachedMode = null;
}
