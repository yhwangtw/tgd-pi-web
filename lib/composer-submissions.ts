"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { AttachedImage } from "@/components/chat/ChatInput";

type SubmissionStatus = "pending" | "failed" | "unknown" | "restored";
export interface ComposerSubmission {
  id: string;
  text: string;
  images: AttachedImage[];
  status: SubmissionStatus;
}
const PREFIX = "pi-composer-delivery:";
const EMPTY: readonly ComposerSubmission[] = [];
const entries = new Map<string, readonly ComposerSubmission[]>();
const retainedDrafts = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): readonly ComposerSubmission[] {
  const cached = entries.get(key);
  if (cached) return cached;
  let restored: ComposerSubmission[] = [];
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(PREFIX + key) ?? "[]");
    if (Array.isArray(saved)) restored = saved.filter((item): item is ComposerSubmission =>
      item && typeof item.id === "string" && typeof item.text === "string" && ["pending", "failed", "unknown", "restored"].includes(item.status)
      && Array.isArray(item.images) && item.images.every((image: AttachedImage) => image && typeof image.data === "string" && typeof image.mimeType === "string"),
    ).map(item => ({ ...item, status: item.status === "pending" ? "unknown" : item.status === "restored" ? "failed" : item.status,
      images: item.images.map(image => ({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` })) }));
  } catch { /* Storage may be unavailable; keep recovery in this tab's memory. */ }
  entries.set(key, restored.length ? restored : EMPTY);
  return entries.get(key)!;
}
function write(key: string, next: readonly ComposerSubmission[]) {
  entries.set(key, next.length ? next : EMPTY);
  let persisted = false;
  try {
    if (next.length) sessionStorage.setItem(PREFIX + key, JSON.stringify(next.map(item => ({ ...item,
      images: item.images.map(({ data, mimeType }) => ({ data, mimeType })),
    }))));
    else sessionStorage.removeItem(PREFIX + key);
    persisted = true;
  } catch { /* Quota does not discard the in-memory copy. */ }
  listeners.forEach(listener => listener());
  return persisted;
}

/** Capture before clearing the editor; synchronous per-session duplicate guard. */
export function beginComposerSubmission(key: string, text: string, images: AttachedImage[], originalDraft = text): { item: ComposerSubmission; persisted: boolean; restoredIds: string[] } | null {
  const current = read(key);
  if (current.some(item => item.status === "pending")) return null;
  const previous = current.find(item => item.text === text && sameSubmissionImages(item.images, images));
  const item: ComposerSubmission = { id: previous?.id ?? (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")), text, status: "pending",
    images: images.map(image => ({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` })) };
  const persisted = write(key, [...current.filter(entry => entry !== previous), item]);
  if (!persisted) retainedDrafts.set(item.id, originalDraft);
  return { item, persisted, restoredIds: current.filter(entry => entry.status === "restored").map(entry => entry.id) };
}
export function sameSubmissionImages(left: AttachedImage[], right: AttachedImage[]) {
  return left.length === right.length && left.every((image, index) => image.data === right[index].data && image.mimeType === right[index].mimeType);
}
export function hasPendingComposerSubmission(key: string) { return read(key).some(item => item.status === "pending"); }
export function retainedComposerDraft(key: string) {
  const pending = read(key).find(item => item.status === "pending");
  return pending ? retainedDrafts.get(pending.id) : undefined;
}
export function restoreComposerSubmission(key: string, id: string) {
  retainedDrafts.delete(id);
  write(key, read(key).map(item => item.id === id ? { ...item, status: "restored" } : item));
}
export function removeComposerSubmission(key: string, id: string, restoredIds: string[] = []) {
  retainedDrafts.delete(id);
  write(key, read(key).filter(item => item.id !== id && !(item.status === "restored" && restoredIds.includes(item.id))));
}
export function failComposerSubmission(key: string, id: string) {
  retainedDrafts.delete(id);
  write(key, read(key).map(item => item.id === id ? { ...item, status: "failed" } : item));
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useComposerSubmissions(key: string) {
  return useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), () => EMPTY);
}
