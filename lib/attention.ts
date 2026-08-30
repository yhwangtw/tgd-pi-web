"use client";

import { useSyncExternalStore } from "react";
import { redactSensitiveText } from "./redaction";

// ============================================================================
// Tab-title store + completion notifications.
// The core usage loop is "send a task, switch away, come back" — the tab
// title and a browser notification are how a background tab says "done".
//
// The title must be rendered through React (<TabTitle /> in AppShell renders
// a hoistable <title>): React 19 owns the head <title>, so raw
// document.title writes get clobbered on the next render.
// ============================================================================

const BASE_TITLE = "π with tGD";

let currentTitle = BASE_TITLE;
let resetTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(title: string) {
  currentTitle = title;
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): string {
  return currentTitle;
}

function getServerSnapshot(): string {
  return BASE_TITLE;
}

/** Reactive tab title — render as <title>{useTabTitle()}</title>. */
export function useTabTitle(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setIdleTitle(sessionName?: string | null): void {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  set(sessionName ? `${sessionName} — ${BASE_TITLE}` : BASE_TITLE);
}

export function setRunningTitle(sessionName?: string | null): void {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  set(`⏳ ${sessionName ?? "Running"} — ${BASE_TITLE}`);
}

/** Flash a ✅ title, then settle back to the idle title. */
export function setDoneTitle(sessionName?: string | null): void {
  set(`✅ ${sessionName ?? "Done"} — ${BASE_TITLE}`);
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => setIdleTitle(sessionName), 8000);
}

/** Flash a ⚠ title for a failed run. */
export function setErrorTitle(sessionName?: string | null): void {
  set(`⚠ ${sessionName ?? "Failed"} — ${BASE_TITLE}`);
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => setIdleTitle(sessionName), 12000);
}

/** Apply a title requested by an extension through the Web UI bridge. */
export function setExtensionTitle(title: string): void {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  set(title || BASE_TITLE);
}

/**
 * Ask for notification permission. Call from a user gesture (send click) —
 * requesting out of the blue gets auto-blocked by browsers.
 */
export function requestNotifyPermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/** Notify that the agent finished — only when the tab isn't being watched. */
export function notifyDone(sessionName?: string | null, errorMessage?: string): void {
  if (typeof document === "undefined" || !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(
      errorMessage
        ? (sessionName ? `Failed — ${sessionName}` : "Agent run failed")
        : (sessionName ? `Done — ${sessionName}` : "Agent finished"),
      {
        body: errorMessage ? redactSensitiveText(errorMessage) : "The agent has finished responding.",
        tag: "pi-agent-done", // collapse repeats instead of stacking
      },
    );
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // constructor can throw on some platforms (e.g. Android) — best-effort
  }
}
