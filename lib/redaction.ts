const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|passwd|credential|credentials)$/i;
const SENSITIVE_ENV_KEY = /(?:^|_)(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSWD|SECRET|TOKEN)$/i;
const ENV_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*\}$/i;

function isSafeReference(value: string): boolean {
  return ENV_REFERENCE.test(value.trim());
}

function redactSecretValue(value: string): string {
  return isSafeReference(value) ? value : REDACTED;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Remove common credential shapes before text crosses a user-visible or
 * export boundary. ${ENV_VAR} references remain because the name is useful
 * configuration context and does not reveal the resolved value.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return input;
  return input
    .replace(/\b(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(/([?&](?:access_token|api[-_]?key|auth|authorization|cookie|credential|password|secret|token)=)([^&#\s]+)/gi,
      (_match, prefix: string, value: string) => `${prefix}${redactSecretValue(decodeURIComponentSafe(value))}`)
    .replace(/(["']?(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?)(Bearer|Basic)\s+(\$\{[A-Z_][A-Z0-9_]*\}|[^"'\s,;}]+)/gi,
      (_match, prefix: string, scheme: string, value: string) => `${prefix}${scheme} ${redactSecretValue(value)}`)
    .replace(/(["']?(?:authorization|proxy-authorization)["']?\s*[:=]\s*)(["']?)(\$\{[A-Z_][A-Z0-9_]*\}|(?!Bearer\b|Basic\b|\[REDACTED\])[^"'\s,;}]+)(\2)/gi,
      (_match, prefix: string, quote: string, value: string) => `${prefix}${quote}${redactSecretValue(value)}${quote}`)
    .replace(/(["']?(?:cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|passwd|credential|credentials)["']?\s*[:=]\s*)(["']?)(\$\{[A-Z_][A-Z0-9_]*\}|(?!\[REDACTED\])[^"'\s,;}\]]+)(\2)/gi,
      (_match, prefix: string, quote: string, value: string) => `${prefix}${quote}${redactSecretValue(value)}${quote}`)
    .replace(/\b(Bearer|Basic)\s+(?!\$\{|\[REDACTED\])([A-Za-z0-9._~+/=-]{6,})/gi, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSWD|SECRET|TOKEN))\s*([=:])\s*([^\s,;]+)/g,
      (_match, key: string, delimiter: string, value: string) => `${key}${delimiter}${value === REDACTED ? value : redactSecretValue(value)}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, REDACTED);
}

/** Return a redacted clone of JSON-compatible data without mutating input. */
export function redactSensitiveValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED as T;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, seen)) as T;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((SENSITIVE_KEY.test(key) || SENSITIVE_ENV_KEY.test(key)) && typeof child === "string") {
      next[key] = redactSecretValue(child);
    } else if (SENSITIVE_KEY.test(key) || SENSITIVE_ENV_KEY.test(key)) {
      next[key] = REDACTED;
    } else {
      next[key] = redactSensitiveValue(child, seen);
    }
  }
  return next as T;
}

export function redactedErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export { REDACTED };
