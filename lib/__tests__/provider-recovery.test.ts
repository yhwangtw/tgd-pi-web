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

  it("separates unsupported parameters from unavailable models and outages", () => {
    expect(classifyProviderError('400: {"message":"reasoning_effort `none` is not supported by this model Request id: abc","type":"invalid_request_error"}'))
      .toMatchObject({ kind: "unsupported_setting", recoverableWithFallback: false });
    expect(classifyProviderError("Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account"))
      .toMatchObject({ kind: "model_unavailable", recoverableWithFallback: false });
    expect(classifyProviderError("This model is temporarily unavailable; 503"))
      .toMatchObject({ kind: "unavailable", recoverableWithFallback: true });
  });
});
