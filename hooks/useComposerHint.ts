"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { cleanComposerHint, HINT_FAILURE_COOLDOWN_MS, HINT_FETCH_TIMEOUT_MS, HINT_MAX_ATTEMPTS, HINT_RETRY_DELAY_MS, HINT_SUCCESS_TTL_MS,
  type ComposerHintMessage } from "@/lib/composer-hints";

const PREFERENCE = "pi-composer-hints";
const EVENT = "pi-composer-hints-change";
interface HintResult { hint: string | null; attempts: number; expires: number; retryAt: number; retryable: boolean; }
const results = new Map<string, HintResult>();
const requests = new Map<string, Promise<HintResult>>();

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
  const recent = saved && saved.expires > Date.now() ? saved : undefined;
  if (recent && (recent.hint || !recent.retryable || recent.retryAt > Date.now())) return Promise.resolve(recent);
  const pending = requests.get(key);
  if (pending) return pending;
  const attempts = (recent?.attempts ?? 0) + 1;
  // Keep a single request alive through draft edits; it is cached, never inserted automatically.
  const request = Promise.resolve().then(async () => {
    let hint: string | null = null;
    let retryable = true;
    let retryDelay = HINT_RETRY_DELAY_MS * 2 ** (attempts - 1);
    try {
      const response = await fetch("/api/composer-hint", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: key,
        signal: AbortSignal.timeout(HINT_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = await response.json();
        if (typeof body.hint === "string") hint = cleanComposerHint(body.hint);
        retryable = body.retryable !== false;
        if (typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs)) {
          retryDelay = Math.max(retryDelay, Math.min(body.retryAfterMs, HINT_FAILURE_COOLDOWN_MS));
        }
      } else {
        retryable = response.status === 429 || response.status >= 500;
      }
    } catch { /* Keep the ordinary placeholder on timeout, offline or provider failure. */ }
    const result: HintResult = { hint, attempts, retryable: !hint && retryable && attempts < HINT_MAX_ATTEMPTS,
      retryAt: Date.now() + retryDelay, expires: Date.now() + (hint ? HINT_SUCCESS_TTL_MS : HINT_FAILURE_COOLDOWN_MS) };
    results.delete(key);
    results.set(key, result);
    if (results.size > 64) results.delete(results.keys().next().value!);
    return result;
  }).finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}

export function useComposerHint({ messages, model, locale, sessionKey, turnKey, idle }: {
  messages?: ComposerHintMessage[] | null;
  model?: { provider: string; modelId: string } | null;
  locale: "en" | "zh";
  sessionKey?: string | null;
  turnKey?: string | null;
  idle: boolean;
}) {
  const enabled = useSyncExternalStore(subscribe, enabledSnapshot, () => true);
  const key = messages?.length && model && sessionKey
    ? JSON.stringify({ provider: model.provider, modelId: model.modelId, locale, messages,
      ...(turnKey ? { turnId: `${sessionKey}:${turnKey}` } : {}) }) : null;
  const [result, setResult] = useState<{ key: string; sessionKey: string; hint: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const identity = `${sessionKey}:${key}`;
  useEffect(() => {
    if (!enabled || !idle || !key || !sessionKey || dismissed === identity) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const result = await requestHint(key);
      if (!active) return;
      setResult({ key, sessionKey, hint: result.hint });
      if (result.retryable) timer = setTimeout(() => { void load(); }, Math.max(0, result.retryAt - Date.now()));
    };
    timer = setTimeout(() => { void load(); }, 700);
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, idle, key, sessionKey, dismissed, identity]);
  const hint = enabled && idle && dismissed !== identity && result?.key === key && result.sessionKey === sessionKey ? result.hint : null;
  const dismiss = useCallback(() => setDismissed(identity), [identity]);
  const reset = useCallback(() => setDismissed(null), []);
  return { hint, enabled, setEnabled, dismiss, reset };
}
