"use client";

import { useSyncExternalStore } from "react";

export const MESSAGE_LAYOUTS = ["split", "left"] as const;
export type MessageLayout = (typeof MESSAGE_LAYOUTS)[number];

export const DEFAULT_MESSAGE_LAYOUT: MessageLayout = "split";

export function normalizeMessageLayout(value: string | null | undefined): MessageLayout {
  return value && (MESSAGE_LAYOUTS as readonly string[]).includes(value)
    ? value as MessageLayout
    : DEFAULT_MESSAGE_LAYOUT;
}

const listeners = new Set<() => void>();
let messageLayout: MessageLayout = DEFAULT_MESSAGE_LAYOUT;

if (typeof window !== "undefined") {
  try {
    messageLayout = normalizeMessageLayout(localStorage.getItem("pi-message-layout"));
  } catch {
    // Storage unavailable — preserve the familiar split layout.
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): MessageLayout {
  return messageLayout;
}

function getServerSnapshot(): MessageLayout {
  return DEFAULT_MESSAGE_LAYOUT;
}

export function setMessageLayout(next: MessageLayout): void {
  messageLayout = next;
  try {
    localStorage.setItem("pi-message-layout", next);
  } catch {
    // Preference persistence is best effort.
  }

  if (next === DEFAULT_MESSAGE_LAYOUT) {
    document.documentElement.removeAttribute("data-message-layout");
  } else {
    document.documentElement.setAttribute("data-message-layout", next);
  }
  listeners.forEach((callback) => callback());
}

export function useMessageLayout(): {
  messageLayout: MessageLayout;
  setMessageLayout: (layout: MessageLayout) => void;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { messageLayout: current, setMessageLayout };
}
