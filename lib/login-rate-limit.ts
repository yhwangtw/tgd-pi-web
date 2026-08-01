const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_CLIENTS = 5_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface LoginAttemptState {
  failures: number[];
  blockedUntil: number;
}

declare global {
  var __piLoginAttempts: Map<string, LoginAttemptState> | undefined;
  var __piLoginAttemptsSweepAt: number | undefined;
}

function store(): Map<string, LoginAttemptState> {
  if (!globalThis.__piLoginAttempts) globalThis.__piLoginAttempts = new Map();
  return globalThis.__piLoginAttempts;
}

function sweep(nowMs: number): void {
  const attempts = store();
  const lastSweep = globalThis.__piLoginAttemptsSweepAt ?? 0;
  if (attempts.size <= MAX_CLIENTS && nowMs - lastSweep < SWEEP_INTERVAL_MS) return;
  globalThis.__piLoginAttemptsSweepAt = nowMs;
  for (const [key, state] of attempts) {
    state.failures = state.failures.filter((timestamp) => nowMs - timestamp < WINDOW_MS);
    if (state.blockedUntil <= nowMs && state.failures.length === 0) attempts.delete(key);
  }
  while (attempts.size > MAX_CLIENTS) {
    const oldestKey = attempts.keys().next().value as string | undefined;
    if (!oldestKey) break;
    attempts.delete(oldestKey);
  }
}

function currentState(key: string, nowMs: number): LoginAttemptState {
  const attempts = store();
  sweep(nowMs);
  const state = attempts.get(key) ?? { failures: [], blockedUntil: 0 };
  state.failures = state.failures.filter((timestamp) => nowMs - timestamp < WINDOW_MS);
  if (state.blockedUntil <= nowMs) state.blockedUntil = 0;
  if (state.failures.length === 0 && state.blockedUntil === 0) attempts.delete(key);
  else attempts.set(key, state);
  return state;
}

export function loginClientKey(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim()
    || headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "direct-client";
}

export function checkLoginRateLimit(key: string, nowMs = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const state = currentState(key, nowMs);
  return state.blockedUntil > nowMs
    ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - nowMs) / 1000)) }
    : { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(key: string, nowMs = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const state = currentState(key, nowMs);
  state.failures.push(nowMs);
  if (state.failures.length >= MAX_FAILURES) state.blockedUntil = nowMs + BLOCK_MS;
  store().set(key, state);
  return checkLoginRateLimit(key, nowMs);
}

export function clearLoginFailures(key: string): void {
  store().delete(key);
}

export function resetLoginRateLimitsForTests(): void {
  store().clear();
  globalThis.__piLoginAttemptsSweepAt = undefined;
}
