import type { AgentRunLimits } from "./agent-run-types";

export const DEFAULT_SUBAGENT_LIMITS = { maxTurns: 0, maxCostUsd: 0, timeoutMs: 0 };

/** Zero explicitly disables a budget; omitted fields retain the caller's defaults. */
export function isAgentRunLimits(value: unknown): value is AgentRunLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const limits = value as Record<string, unknown>;
  if (Object.keys(limits).some((key) => !["maxTurns", "maxCostUsd", "timeoutMs"].includes(key))) return false;
  return (limits.maxTurns === undefined || (Number.isSafeInteger(limits.maxTurns) && Number(limits.maxTurns) >= 0))
    && (limits.maxCostUsd === undefined || (typeof limits.maxCostUsd === "number" && Number.isFinite(limits.maxCostUsd) && limits.maxCostUsd >= 0))
    && (limits.timeoutMs === undefined || (Number.isSafeInteger(limits.timeoutMs) && Number(limits.timeoutMs) >= 0 && Number(limits.timeoutMs) <= 2_147_483_647));
}

export function approachingRunLimit(limits: AgentRunLimits | undefined, turns: number, cost: number, elapsed: number): boolean {
  return !!limits && ((!!limits.maxTurns && turns >= limits.maxTurns * .8)
    || (!!limits.maxCostUsd && cost >= limits.maxCostUsd * .8)
    || (!!limits.timeoutMs && elapsed >= limits.timeoutMs * .8));
}

/** A model may allocate a smaller budget, never raise a user-configured cap. */
export function allocateRunLimits(configured: AgentRunLimits, requested: AgentRunLimits = {}): AgentRunLimits {
  return Object.fromEntries((["maxTurns", "maxCostUsd", "timeoutMs"] as const).map(key => {
    const ceiling = configured[key] ?? 0;
    const allocation = requested[key] ?? 0;
    return [key, ceiling > 0 ? allocation > 0 ? Math.min(ceiling, allocation) : ceiling : allocation];
  }));
}
