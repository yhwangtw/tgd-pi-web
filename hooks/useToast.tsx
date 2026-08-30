"use client";

import { useCallback, useSyncExternalStore, type ReactElement } from "react";
import { ToastContainer } from "@/components/ui/Toast";
import { redactSensitiveText } from "@/lib/redaction";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  type?: ToastType;
  /** Auto-dismiss in ms. 0 = sticky (must be closed manually). Default 3000. */
  duration?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

export interface UseToastApi {
  showToast: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
  /** Drop-in component to mount once at app root. */
  ToastContainer: () => ReactElement;
}

// ============================================================================
// Module-level store. useToast() used to keep per-instance state, which meant
// showToast from a component without its own mounted <ToastContainer /> (e.g.
// SessionSidebar) silently displayed nothing. One global store + the single
// container mounted in AppShell makes every caller's toasts visible.
// ============================================================================

let toasts: ToastItem[] = [];
let nextId = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ToastItem[] {
  return toasts;
}

const EMPTY: ToastItem[] = [];
function getServerSnapshot(): ToastItem[] {
  return EMPTY;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  emit();
}

/** Standalone imperative API — usable from hooks and non-component code. */
export function showToast(message: string, opts: ToastOptions = {}): number {
  const id = ++nextId;
  const type: ToastType = opts.type ?? "info";
  const duration = opts.duration ?? 3000;
  // Cap at 6 visible toasts — drop oldest.
  toasts = [...toasts, { id, message: redactSensitiveText(message), type, duration }];
  if (toasts.length > 6) toasts = toasts.slice(1);
  if (duration > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), duration));
  }
  emit();
  return id;
}

export function useToast(): UseToastApi {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const Container = useCallback(
    () => <ToastContainer toasts={items} onDismiss={dismissToast} />,
    [items],
  );

  return { showToast, dismiss: dismissToast, ToastContainer: Container };
}
