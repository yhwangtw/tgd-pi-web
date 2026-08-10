export type ProviderErrorKind = "rate_limit" | "billing" | "authentication" | "unavailable" | "network" | "context" | "unknown";

export interface ProviderRecoveryModel {
  provider: string;
  modelId: string;
  name: string;
}

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  retryAfterSeconds: number | null;
  recoverableWithFallback: boolean;
}

const RETRY_AFTER_PATTERNS = [
  /retry(?:ing)?\s+(?:after|in)\s+(\d+)\s*(?:s|sec|seconds?)/i,
  /retry-after[^\d]*(\d+)/i,
  /try again in\s+(\d+)\s*(?:s|sec|seconds?)/i,
];

export function classifyProviderError(message: string): ProviderErrorInfo {
  const retryAfterSeconds = RETRY_AFTER_PATTERNS
    .map((pattern) => message.match(pattern)?.[1])
    .find(Boolean);
  const retryAfter = retryAfterSeconds ? Number.parseInt(retryAfterSeconds, 10) : null;

  if (/context(?: length| window)|too many tokens|maximum context|context_length_exceeded/i.test(message)) {
    return { kind: "context", retryAfterSeconds: retryAfter, recoverableWithFallback: false };
  }
  if (/429|rate.?limit|too many requests|quota.*(?:minute|hour)|throttl/i.test(message)) {
    return { kind: "rate_limit", retryAfterSeconds: retryAfter, recoverableWithFallback: true };
  }
  if (/insufficient (?:balance|credit)|billing|payment required|quota exceeded|usage limit/i.test(message)) {
    return { kind: "billing", retryAfterSeconds: retryAfter, recoverableWithFallback: true };
  }
  if (/no api key|unauthori[sz]ed|authentication|credential|sign[ -]?in|log[ -]?in|invalid.*key/i.test(message)) {
    return { kind: "authentication", retryAfterSeconds: retryAfter, recoverableWithFallback: true };
  }
  if (/503|502|504|overloaded|temporar(?:y|ily) unavailable|service unavailable|capacity/i.test(message)) {
    return { kind: "unavailable", retryAfterSeconds: retryAfter, recoverableWithFallback: true };
  }
  if (/network|fetch failed|connection (?:reset|closed|refused)|socket|timed? out|econn/i.test(message)) {
    return { kind: "network", retryAfterSeconds: retryAfter, recoverableWithFallback: true };
  }
  return { kind: "unknown", retryAfterSeconds: retryAfter, recoverableWithFallback: false };
}

/** Prefer another provider so one account outage cannot take every fallback down. */
export function selectFallbackModel(
  current: { provider: string; modelId: string } | null,
  models: ProviderRecoveryModel[],
): ProviderRecoveryModel | null {
  if (models.length === 0) return null;
  const alternatives = models.filter((model) => !current || model.provider !== current.provider || model.modelId !== current.modelId);
  return alternatives.find((model) => !current || model.provider !== current.provider)
    ?? alternatives[0]
    ?? null;
}
