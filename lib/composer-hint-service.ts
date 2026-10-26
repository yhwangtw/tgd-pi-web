import { createHash } from "node:crypto";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createPiModelRegistry } from "./pi-model-runtime";
import { HINT_FAILURE_COOLDOWN_MS, HINT_MAX_ATTEMPTS, HINT_MODEL_TIMEOUT_MS, HINT_RETRY_DELAY_MS, HINT_SUCCESS_TTL_MS,
  type ComposerHintRequest, type ComposerHintResult } from "./composer-hints";
import { composerHintLocale, composerHintPrompt, selectComposerHint } from "./composer-hint-prompt";

const cache = new Map<string, { result: ComposerHintResult; retryAt: number; attempts: number; budgetUntil: number }>();
const pending = new Map<string, Promise<ComposerHintResult>>();

const emptyResult = (status: ComposerHintResult["status"], retryable = true): ComposerHintResult => ({
  hint: null, status, retryable, retryAfterMs: retryable ? HINT_RETRY_DELAY_MS : 0,
});

/** A bounded, tool-free completion. Failure is a quiet return to the normal placeholder. */
export async function generateComposerHint(body: ComposerHintRequest, signal: AbortSignal): Promise<ComposerHintResult> {
  const key = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const now = Date.now();
  const saved = cache.get(key);
  if (saved && saved.retryAt > now) return { ...saved.result,
    retryAfterMs: saved.result.retryable ? saved.retryAt - now : 0 };
  const existing = pending.get(key);
  if (existing) return existing;
  // Drop excess hint work instead of queuing it.
  if (pending.size >= 2) return emptyResult("busy");
  if (signal.aborted) return emptyResult("error");
  const attempts = saved && saved.budgetUntil > now ? saved.attempts + 1 : 1;
  const task = (async () => {
    let outcome = emptyResult("error");
    try {
      const { registry } = await createPiModelRegistry();
      const model = registry.find(body.provider, body.modelId);
      if (!model || registry.getError()) return outcome = emptyResult("unavailable", false);
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return outcome = emptyResult("unavailable", false);
      let responseStatus: number | undefined;
      const result = await completeSimple(model, {
        systemPrompt: composerHintPrompt(composerHintLocale(body), !!body.context),
        messages: [{ role: "user", content: JSON.stringify({ messages: body.messages,
          ...(body.context ? { context: body.context } : {}), ...(body.excluded?.length ? { excluded: body.excluded } : {}) }), timestamp: Date.now() }],
      }, {
        apiKey: auth.apiKey, headers: auth.headers,
        // Omitting reasoning uses Pi's off/default path, including compat clients.
        maxTokens: body.context ? 200 : 120, maxRetries: 0, timeoutMs: HINT_MODEL_TIMEOUT_MS,
        onResponse: response => { responseStatus = response.status; },
        cacheRetention: "none", signal: AbortSignal.any([signal, AbortSignal.timeout(HINT_MODEL_TIMEOUT_MS)]),
      });
      if (result.stopReason !== "error" && result.stopReason !== "aborted" && result.stopReason !== "length") {
        const hint = selectComposerHint(result.content.filter(block => block.type === "text").map(block => block.text).join(""), body);
        outcome = hint ? { hint, status: "ready", retryable: false, retryAfterMs: 0 } : emptyResult("empty");
      } else if (responseStatus && [401, 402, 403, 404].includes(responseStatus)) {
        outcome = emptyResult("unavailable", false);
      }
    } catch { /* Provider errors must not interrupt the composer or expose private configuration. */ }
    finally {
      if (attempts >= HINT_MAX_ATTEMPTS) outcome.retryable = false;
      const retryDelay = outcome.retryable ? HINT_RETRY_DELAY_MS * 2 ** (attempts - 1) : 0;
      outcome.retryAfterMs = retryDelay;
      cache.delete(key);
      cache.set(key, { result: outcome, attempts, budgetUntil: Date.now() + HINT_FAILURE_COOLDOWN_MS,
        retryAt: Date.now() + (outcome.hint ? HINT_SUCCESS_TTL_MS : retryDelay || HINT_FAILURE_COOLDOWN_MS) });
      if (cache.size > 128) cache.delete(cache.keys().next().value!);
    }
    return outcome;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
