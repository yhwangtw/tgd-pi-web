import { describe, expect, it } from "vitest";
import { buildSessionAnalyticsReport, costState, emptyCostCoverage, type AnalyticsEntry, type AnalyticsSessionInput } from "../session-analytics";

function session(entries: AnalyticsEntry[], id = "fixture"): AnalyticsSessionInput {
  return { id, cwd: "/fixture", created: "2026-01-01", modified: "2026-09-05", entries };
}
function response(provider: string, usage?: NonNullable<AnalyticsEntry["message"]>["usage"], timestamp = "2026-01-31T23:30:00Z"): AnalyticsEntry {
  return { type: "message", timestamp, message: { role: "assistant", provider, model: "same/model", usage } };
}

describe("historical analytics", () => {
  it("keeps same-named models distinct by their full provider identity", () => {
    const { summary } = buildSessionAnalyticsReport([session([
      response("vendor/a", { input: 20, cost: { total: 1 } }),
      response("vendor/b", { input: 30, cost: { total: 2 } }),
    ])]);
    expect(summary.byModel.map(m => [m.provider, m.modelId, m.cost])).toEqual([
      ["vendor/b", "same/model", 2], ["vendor/a", "same/model", 1],
    ]);
    expect(summary.byProvider.map(p => p.provider)).toEqual(["vendor/b", "vendor/a"]);
  });

  it("distinguishes missing usage, missing cost, recorded zero and partial estimates", () => {
    const { summary } = buildSessionAnalyticsReport([session([
      response("no-usage"), response("no-price", { input: 5 }),
      response("zero", { input: 5, cost: { total: 0 } }),
      response("paid", { input: 5, cost: { total: .25 } }),
    ])]);
    expect(summary.coverage).toEqual({ recorded: 2, recordedZero: 1, missingCost: 1, missingUsage: 1 });
    expect(costState(summary.coverage)).toBe("partial");
    expect(Object.fromEntries(summary.byModel.map(m => [m.provider, costState(m.coverage)]))).toEqual({
      "no-usage": "no_usage", "no-price": "unknown", zero: "recorded_zero", paid: "recorded",
    });
    expect(costState(emptyCostCoverage())).toBe("no_usage");
  });

  it("uses message UTC month, not last-modified month, and counts alternate branches", () => {
    const { summary, scope } = buildSessionAnalyticsReport([session([
      response("p", { cost: { total: 1 } }, "2026-02-01T00:30:00+08:00"),
      response("p", { cost: { total: 2 } }, "2026-02-02T00:30:00Z"),
      response("p", { cost: { total: 3 } }, "invalid"),
    ])]);
    expect(summary.monthly.map(m => [m.month, m.cost])).toEqual([["unknown", 3], ["2026-02", 2], ["2026-01", 1]]);
    expect(summary.totalMessages).toBe(3);
    expect(scope.history).toBe("all_stored_branches");
  });

  it("does not count skipped files as readable sessions", () => {
    const report = buildSessionAnalyticsReport([session([])], 3);
    expect(report.scope.skippedSessions).toBe(2);
    expect(report.summary.sessionCount).toBe(1);
  });

  it("keeps malformed numeric values out of totals and treats invalid cost as unknown", () => {
    const report = buildSessionAnalyticsReport([session([
      response("p", { input: NaN, output: Infinity, cacheRead: -3, cost: { total: NaN } }),
      response("p", { input: 12, cacheWrite: 4, cost: { total: .1 } }),
      response("__proto__", { input: 1, cost: { total: 0 } }),
    ])]);
    expect(report.summary.totalCost).toBe(.1);
    expect(report.summary.totalTokens).toBe(17);
    expect(report.summary.coverage.missingCost).toBe(1);
  });
});
