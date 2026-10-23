"use client";

import { useSyncExternalStore } from "react";

/** Client-facing tag → sessions map, shared by sidebar and command search. */
export type SessionTags = Record<string, string[]>;
const EMPTY = { tags: {} as SessionTags, loading: true };
let snapshot = EMPTY;
let pending: Promise<void> | null = null;
let revision = 0;
let activeMutations = 0;
let reloadAfterMutation = false;
let reverseIndex = new Map<string, string[]>();
const listeners = new Set<() => void>();
const NO_TAGS: string[] = [];

function publish(tags: SessionTags, loading = false) {
  if (snapshot.loading === loading && JSON.stringify(tags) === JSON.stringify(snapshot.tags)) return;
  reverseIndex = new Map();
  for (const [tag, sessions] of Object.entries(tags)) {
    for (const session of sessions) {
      const current = reverseIndex.get(session) ?? [];
      current.push(tag);
      reverseIndex.set(session, current);
    }
  }
  snapshot = { tags, loading };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void load();
  return () => { listeners.delete(listener); };
}
function load(): Promise<void> {
  if (activeMutations) { reloadAfterMutation = true; return Promise.resolve(); }
  if (pending) return pending;
  const startedRevision = revision;
  pending = (async () => {
    try {
      const response = await fetch("/api/sessions/tags");
      if (!response.ok) return;
      const data = await response.json() as { tags?: Record<string, string[]> };
      const inverted: SessionTags = Object.create(null);
      for (const [sessionId, tagList] of Object.entries(data.tags ?? {})) {
        if (!Array.isArray(tagList)) continue;
        for (const tag of tagList) {
          if (typeof tag !== "string") continue;
          const sessions = inverted[tag] ??= [];
          if (!sessions.includes(sessionId)) sessions.push(sessionId);
        }
      }
      if (startedRevision === revision) publish(inverted);
    } catch { /* keep the last available tags */ }
    finally {
      pending = null;
      if (snapshot.loading) publish(snapshot.tags);
      // An initial GET must not overwrite an optimistic edit made in flight.
      if (startedRevision !== revision && listeners.size) void load();
    }
  })();
  return pending;
}

async function mutate(sessionId: string, tag: string, remove: boolean) {
  const norm = tag.toLowerCase().trim().replace(/^#/, "").slice(0, 32);
  if (!norm) return;
  revision += 1;
  activeMutations += 1;
  const next: SessionTags = Object.assign(Object.create(null), snapshot.tags);
  const current = Object.hasOwn(next, norm) ? next[norm] : [];
  if (remove) {
    const remaining = current.filter((id) => id !== sessionId);
    if (remaining.length) next[norm] = remaining;
    else delete next[norm];
  } else next[norm] = current.includes(sessionId) ? current : [...current, sessionId];
  publish(next);
  try {
    const response = await fetch("/api/sessions/tags", {
      method: remove ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, tag: norm }),
    });
    if (!response.ok) reloadAfterMutation = true;
  } catch { reloadAfterMutation = true; }
  finally {
    activeMutations -= 1;
    if (!activeMutations && reloadAfterMutation) {
      reloadAfterMutation = false;
      await load();
    }
  }
}
const setTag = (sessionId: string, tag: string) => mutate(sessionId, tag, false);
const removeTag = (sessionId: string, tag: string) => mutate(sessionId, tag, true);
const sessionTagsOf = (sessionId: string): string[] => reverseIndex.get(sessionId) ?? NO_TAGS;

export function useTags() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  return { ...current, load, setTag, removeTag, sessionTagsOf };
}
