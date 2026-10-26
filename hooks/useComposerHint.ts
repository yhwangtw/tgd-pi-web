"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { cleanComposerHint, type ComposerHintMessage } from "@/lib/composer-hints";

const PREFERENCE = "pi-composer-hints";
const EVENT = "pi-composer-hints-change";
const results = new Map<string, { hint: string | null; expires: number }>();
const requests = new Map<string, Promise<string | null>>();

function enabledSnapshot() {
  try { return localStorage.getItem(PREFERENCE) !== "off"; } catch { return true; }
}
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener("storage", callback); };
}
function setEnabled(enabled: boolean) {
  try { localStorage.setItem(PREFERENCE, enabled ? "on" : "off"); } catch { /* Storage can be unavailable. */ }
  window.dispatchEvent(new Event(EVENT));
}
function requestHint(key: string) {
  const saved = results.get(key);
  if (saved && saved.expires > Date.now()) return Promise.resolve(saved.hint);
  const pending = requests.get(key);
  if (pending) return pending;
  // Keep a single request alive through draft edits; it is cached, never inserted automatically.
  const request = (async () => {
    let hint: string | null = null;
    try {
      const response = await fetch("/api/composer-hint", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: key,
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const body = await response.json();
        if (typeof body.hint === "string") hint = cleanComposerHint(body.hint);
      }
    } catch { /* Keep the ordinary placeholder on timeout, offline or provider failure. */ }
    results.delete(key);
    results.set(key, { hint, expires: Date.now() + 10 * 60_000 });
    if (results.size > 64) results.delete(results.keys().next().value!);
    requests.delete(key);
    return hint;
  })();
  requests.set(key, request);
  return request;
}

export function useComposerHint({ messages, model, locale, sessionKey, idle }: {
  messages?: ComposerHintMessage[] | null;
  model?: { provider: string; modelId: string } | null;
  locale: "en" | "zh";
  sessionKey?: string | null;
  idle: boolean;
}) {
  const enabled = useSyncExternalStore(subscribe, enabledSnapshot, () => true);
  const key = messages?.length && model && sessionKey
    ? JSON.stringify({ provider: model.provider, modelId: model.modelId, locale, messages }) : null;
  const [result, setResult] = useState<{ key: string; sessionKey: string; hint: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const identity = `${sessionKey}:${key}`;
  useEffect(() => {
    if (!enabled || !idle || !key || !sessionKey || dismissed === identity) return;
    let active = true;
    const timer = setTimeout(() => {
      void requestHint(key).then(hint => { if (active) setResult({ key, sessionKey, hint }); });
    }, 700);
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, idle, key, sessionKey, dismissed, identity]);
  const hint = enabled && idle && dismissed !== identity && result?.key === key && result.sessionKey === sessionKey ? result.hint : null;
  return { hint, enabled, setEnabled, dismiss: () => setDismissed(identity) };
}
