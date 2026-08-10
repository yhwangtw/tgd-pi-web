import { describe, expect, it } from "vitest";
import { classifyProviderError, selectFallbackModel } from "../provider-recovery";

describe("provider recovery", () => {
  it("classifies actionable provider failures without treating context overflow as failover", () => {
    expect(classifyProviderError("429 rate limit; retry after 12 seconds")).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 12, recoverableWithFallback: true });
    expect(classifyProviderError("401 unauthorized API key")).toMatchObject({ kind: "authentication", recoverableWithFallback: true });
    expect(classifyProviderError("context_length_exceeded")).toMatchObject({ kind: "context", recoverableWithFallback: false });
  });

  it("prefers a fallback from another provider", () => {
    const result = selectFallbackModel({ provider: "alpha", modelId: "one" }, [
      { provider: "alpha", modelId: "one", name: "One" },
      { provider: "alpha", modelId: "two", name: "Two" },
      { provider: "beta", modelId: "three", name: "Three" },
    ]);
    expect(result).toEqual({ provider: "beta", modelId: "three", name: "Three" });
  });
});
