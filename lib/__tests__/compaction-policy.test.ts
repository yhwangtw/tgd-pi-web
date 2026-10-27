import { describe, expect, it } from "vitest";
import { SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import { compactionThreshold } from "../compaction-policy";

const defaults = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
describe("Pi compaction policy presentation", () => {
  it.each([32_768, 128_000, 1_000_000])("matches Pi's strict token threshold for a %i-token window", contextWindow => {
    const threshold = contextWindow - defaults.reserveTokens;
    for (const tokens of [threshold - 1, threshold, threshold + 1]) {
      const usage = { tokens, contextWindow, percent: tokens / contextWindow * 100 };
      expect(compactionThreshold(usage, defaults)).toEqual({ tokens: threshold, percent: threshold / contextWindow * 100, exceeded: shouldCompact(tokens, contextWindow, defaults) });
    }
  });
  it("uses official defaults and independent model overrides without inventing a percentage", () => {
    const settings = SettingsManager.inMemory({ compaction: { modelOverrides: { "fixture/small": { reserveTokens: 8_192 }, "fixture/large": { keepRecentTokens: 40_000 } } } });
    expect(settings.getCompactionSettings()).toEqual(defaults);
    expect(settings.getCompactionSettings({ provider: "fixture", id: "small" })).toEqual({ ...defaults, reserveTokens: 8_192 });
    expect(settings.getCompactionSettings({ provider: "fixture", id: "large" })).toEqual({ ...defaults, keepRecentTokens: 40_000 });
  });
  it("keeps disabled auto compaction neutral even above the threshold", () => {
    const usage = { percent: 99, tokens: 99_000, contextWindow: 100_000 };
    expect(compactionThreshold(usage, { ...defaults, enabled: false })?.exceeded).toBe(false);
  });
  it("does not infer threshold pressure from stale or unknown token usage", () => {
    expect(compactionThreshold({ percent: 99, tokens: null, contextWindow: 100_000 }, defaults)?.exceeded).toBe(false);
    expect(compactionThreshold({ percent: null, tokens: null, contextWindow: 0 }, defaults)).toBeNull();
    expect(compactionThreshold(null, defaults)).toBeNull();
    expect(compactionThreshold({ percent: 99, tokens: 99_000, contextWindow: 100_000 }, null)).toBeNull();
  });
});
