"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { cleanComposerHint, HINT_FAILURE_COOLDOWN_MS, HINT_FETCH_TIMEOUT_MS, HINT_MAX_ATTEMPTS, HINT_RETRY_DELAY_MS, HINT_SUCCESS_TTL_MS,
  type ComposerHintMessage } from "@/lib/composer-hints";
import { normalizedHint, type ComposerHintContext } from "@/lib/composer-hint-context";

const PREFERENCE = "pi-composer-hints";
const EVENT = "pi-composer-hints-change";
interface HintResult { hint: string | null; attempts: number; expires: number; retryAt: number; retryable: boolean; }
const results = new Map<string, HintResult>();
const requests = new Map<string, Promise<HintResult>>();
const exclusions = new Map<string, string[]>();
function readExclusions(scope: string): string[] {
  const saved = exclusions.get(scope);
  if (saved) return saved;
  let hints: string[] = [];
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(`pi-hint-dismissed:${scope}`) ?? "[]");
    if (Array.isArray(stored)) hints = stored.filter((hint): hint is string => typeof hint === "string" && hint.length <= 160).slice(-3);
  } catch { /* Tab storage may be unavailable. */ }
  exclusions.set(scope, hints);
  if (exclusions.size > 64) exclusions.delete(exclusions.keys().next().value!);
  return hints;
}
function excludeHint(scope: string, hint: string) {
  const hints = [...readExclusions(scope).filter(saved => normalizedHint(saved) !== normalizedHint(hint)), hint].slice(-3);
  exclusions.delete(scope); exclusions.set(scope, hints);
  if (exclusions.size > 64) exclusions.delete(exclusions.keys().next().value!);
  // Only rejected generated text is kept in this tab, never typed drafts or transcripts.
  try {
    sessionStorage.setItem(`pi-hint-dismissed:${scope}`, JSON.stringify(hints));
    const keys = Object.keys(sessionStorage).filter(key => key.startsWith("pi-hint-dismissed:"));
    for (const key of keys.slice(0, Math.max(0, keys.length - 64))) sessionStorage.removeItem(key);
  } catch { /* Memory-only fallback. */ }
  window.dispatchEvent(new Event(EVENT));
}
function scopeHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

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
        if (typeof body.hint === "string") {
          hint = cleanComposerHint(body.hint);
          const excluded = (JSON.parse(key) as { excluded?: string[] }).excluded;
          if (hint && excluded?.some(text => normalizedHint(text) === normalizedHint(hint!))) hint = null;
        }
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

export function useComposerHint({ messages, context, model, locale, sessionKey, turnKey, idle }: {
  messages?: ComposerHintMessage[] | null;
  context?: ComposerHintContext;
  model?: { provider: string; modelId: string } | null;
  locale: "en" | "zh";
  sessionKey?: string | null;
  turnKey?: string | null;
  idle: boolean;
}) {
  const enabled = useSyncExternalStore(subscribe, enabledSnapshot, () => true);
  const scope = `${sessionKey ?? ""}:${turnKey ?? scopeHash(JSON.stringify(messages ?? []))}`;
  const excludedSnapshot = useSyncExternalStore(subscribe, () => JSON.stringify(readExclusions(scope)), () => "[]");
  const excluded = JSON.parse(excludedSnapshot) as string[];
  const key = messages?.length && model && sessionKey
    ? JSON.stringify({ provider: model.provider, modelId: model.modelId, locale, messages,
      ...(context ? { context, sessionId: sessionKey } : {}), ...(excluded.length ? { excluded } : {}),
      ...(turnKey ? { turnId: `${sessionKey}:${turnKey}` } : {}) }) : null;
  const [result, setResult] = useState<{ key: string; sessionKey: string; hint: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !idle || !key || !sessionKey || dismissed === scope || excluded.length >= 3) return;
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
  }, [enabled, idle, key, sessionKey, dismissed, scope, excluded.length]);
  const hint = enabled && idle && dismissed !== scope && excluded.length < 3 && result?.key === key && result.sessionKey === sessionKey ? result.hint : null;
  const dismiss = useCallback(() => {
    if (hint) excludeHint(scope, hint);
    setDismissed(scope);
  }, [scope, hint]);
  const reset = useCallback(() => setDismissed(null), []);
  return { hint, enabled, setEnabled, dismiss, reset };
}
