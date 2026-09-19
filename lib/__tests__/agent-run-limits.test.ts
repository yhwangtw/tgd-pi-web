import { describe, expect, it } from "vitest";
import { approachingRunLimit, isAgentRunLimits } from "../agent-run-limits";
import { textPreviewLimit, TEXT_PREVIEW_EXPANDED_MAX_BYTES } from "../preview-limits";

describe("smooth work budgets", () => {
  it("supports explicit unlimited settings but rejects malformed budgets", () => {
    expect(isAgentRunLimits({ maxTurns: 0, maxCostUsd: 0, timeoutMs: 0 })).toBe(true);
    for (const input of [{ maxTurns: -1 }, { maxTurns: 1.2 }, { maxCostUsd: Infinity }, { timeoutMs: 3e12 }, { typo: 1 }]) expect(isAgentRunLimits(input)).toBe(false);
  });
  it("warns at 80 percent without treating unlimited as exhausted", () => {
    expect(approachingRunLimit({ maxTurns: 10 }, 8, 0, 0)).toBe(true);
    expect(approachingRunLimit({ maxCostUsd: 5 }, 0, 4, 0)).toBe(true);
    expect(approachingRunLimit({ timeoutMs: 100 }, 0, 0, 80)).toBe(true);
    expect(approachingRunLimit({ maxTurns: 0, timeoutMs: 0 }, 100, 100, 100)).toBe(false);
  });
  it("bounds expanded previews independently of total file size", () => {
    expect(textPreviewLimit(null)).toBe(256 * 1024);
    expect(textPreviewLimit(String(TEXT_PREVIEW_EXPANDED_MAX_BYTES))).toBe(TEXT_PREVIEW_EXPANDED_MAX_BYTES);
    expect(textPreviewLimit("900000000")).toBeNull();
    expect(textPreviewLimit("NaN")).toBeNull();
  });
});
