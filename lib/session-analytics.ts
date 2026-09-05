import { addUsage, emptyUsage, type AssistantUsage, type PartialUsage } from "./usage-aggregation";

export interface CostCoverage {
  recorded: number;
  recordedZero: number;
  missingCost: number;
  missingUsage: number;
}
export function emptyCostCoverage(): CostCoverage {
  return { recorded: 0, recordedZero: 0, missingCost: 0, missingUsage: 0 };
}
export function costState(c: CostCoverage): "no_usage" | "unknown" | "partial" | "recorded_zero" | "recorded" {
  if (!c.recorded && !c.missingCost) return "no_usage";
  if (!c.recorded) return "unknown";
  if (c.missingCost || c.missingUsage) return "partial";
  return c.recorded === c.recordedZero ? "recorded_zero" : "recorded";
}
function countCost(c: CostCoverage, usage?: PartialUsage | null) {
  if (!usage) c.missingUsage++;
  else if (typeof usage.cost?.total !== "number" || !Number.isFinite(usage.cost.total) || usage.cost.total < 0) c.missingCost++;
  else {
    c.recorded++;
    if (usage.cost.total === 0) c.recordedZero++;
  }
}
export interface AnalyticsEntry {
  type: string;
  timestamp?: string;
  provider?: string;
  modelId?: string;
  message?: { role: string; usage?: PartialUsage | null; model?: string; provider?: string };
}
export interface AnalyticsSessionInput {
  id: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  entries: AnalyticsEntry[];
}
export interface SessionAnalytics {
  id: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  modelChanges: Array<{ provider: string; modelId: string; timestamp?: string }>;
  usage: { total: AssistantUsage; byModel: Record<string, AssistantUsage> };
  coverage: CostCoverage;
  compactions: number;
}

// Persisted history (including alternate branches), never account billing.
// Missing usage/prices and zero-valued records are not evidence of a free model.
export function buildSessionAnalyticsReport(sessions: AnalyticsSessionInput[], listedSessions = sessions.length) {
  const perSession: SessionAnalytics[] = [];
  const monthly = new Map<string, { cost: number; tokens: number; sessions: Set<string>; messages: number; coverage: CostCoverage }>();
  const byModel = new Map<string, { provider: string; modelId: string; cost: number; input: number; output: number; sessions: Set<string>; coverage: CostCoverage }>();
  const byProvider = new Map<string, { cost: number; sessions: Set<string>; coverage: CostCoverage }>();
  const coverage = emptyCostCoverage();
  let totalCost = 0, totalTokens = 0, totalMessages = 0;
  for (const session of sessions) {
    const total = emptyUsage();
    const perModel: Record<string, AssistantUsage> = Object.create(null);
    const sessionCoverage = emptyCostCoverage();
    const modelChanges: SessionAnalytics["modelChanges"] = [];
    let compactions = 0, messageCount = 0;
    for (const entry of session.entries) {
      if (entry.type === "model_change" && entry.provider && entry.modelId) {
        modelChanges.push({ provider: entry.provider, modelId: entry.modelId, timestamp: entry.timestamp });
      }
      if (entry.type === "compaction") compactions++;
      if (entry.type !== "message" || !entry.message) continue;
      messageCount++;
      const date = new Date(entry.timestamp ?? "");
      const month = Number.isNaN(date.valueOf()) ? "unknown" : date.toISOString().slice(0, 7);
      let bucket = monthly.get(month);
      if (!bucket) {
        bucket = { cost: 0, tokens: 0, sessions: new Set(), messages: 0, coverage: emptyCostCoverage() };
        monthly.set(month, bucket);
      }
      bucket.sessions.add(session.id);
      bucket.messages++;
      if (entry.message.role !== "assistant") continue;
      const usage = entry.message.usage;
      const provider = entry.message.provider || "?";
      const modelId = entry.message.model || "?";
      // Tuple identity also supports slashes in custom provider/model IDs.
      const key = JSON.stringify([provider, modelId]);
      if (!perModel[key]) perModel[key] = emptyUsage();
      addUsage(perModel[key], usage);
      addUsage(total, usage);
      const normalized = emptyUsage();
      addUsage(normalized, usage);
      let model = byModel.get(key);
      if (!model) {
        model = { provider, modelId, cost: 0, input: 0, output: 0, sessions: new Set(), coverage: emptyCostCoverage() };
        byModel.set(key, model);
      }
      let providerRow = byProvider.get(provider);
      if (!providerRow) {
        providerRow = { cost: 0, sessions: new Set(), coverage: emptyCostCoverage() };
        byProvider.set(provider, providerRow);
      }
      for (const item of [coverage, sessionCoverage, bucket.coverage, model.coverage, providerRow.coverage]) countCost(item, usage);
      bucket.cost += normalized.cost.total;
      bucket.tokens += normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite;
      model.cost += normalized.cost.total;
      model.input += normalized.input;
      model.output += normalized.output;
      model.sessions.add(session.id);
      providerRow.cost += normalized.cost.total;
      providerRow.sessions.add(session.id);
    }
    totalCost += total.cost.total;
    totalTokens += total.input + total.output + total.cacheRead + total.cacheWrite;
    totalMessages += messageCount;
    perSession.push({ id: session.id, name: session.name, cwd: session.cwd, created: session.created, modified: session.modified, messageCount, modelChanges, usage: { total, byModel: perModel }, coverage: sessionCoverage, compactions });
  }
  return {
    scope: { projects: "all" as const, history: "all_stored_branches" as const, monthlyBasis: "message_timestamp_utc" as const, listedSessions, skippedSessions: listedSessions - sessions.length },
    summary: {
      totalCost, totalTokens, totalMessages, sessionCount: sessions.length, coverage,
      monthly: [...monthly].sort(([a], [b]) => b.localeCompare(a)).map(([month, v]) => ({ month, ...v, sessions: v.sessions.size })),
      byModel: [...byModel].sort(([, a], [, b]) => b.cost - a.cost).map(([model, v]) => ({ model, ...v, sessions: v.sessions.size })),
      byProvider: [...byProvider].sort(([, a], [, b]) => b.cost - a.cost).map(([provider, v]) => ({ provider, ...v, sessions: v.sessions.size })),
    },
    perSession,
  };
}
export type AnalyticsReport = ReturnType<typeof buildSessionAnalyticsReport>;
