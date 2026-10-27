/** Settings resolved by Pi for the selected model; never a Web-owned policy. */
export interface ResolvedCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CompactionContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/** Mirror Pi's strict threshold only for presentation; Pi owns when to compact. */
export function compactionThreshold(usage: CompactionContextUsage | null, settings: ResolvedCompactionSettings | null) {
  if (!usage || !settings || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  const tokens = usage.contextWindow - settings.reserveTokens;
  return {
    tokens,
    percent: tokens / usage.contextWindow * 100,
    exceeded: settings.enabled && usage.tokens !== null && usage.tokens > tokens,
  };
}
