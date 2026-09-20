import { describe, expect, it } from "vitest";
import { presentProviderError } from "../provider-error-presentation";

describe("provider error presentation", () => {
  it("keeps raw JSON and request ids out of the summary", () => {
    const raw = '400: {"message":"reasoning_effort `none` is not supported by this model Request id: abc-123","type":"invalid_request_error","param":null}';
    const result = presentProviderError(raw, "Failed");
    expect(result.summary).toBe("This model does not support the selected thinking level. Choose another level.");
    expect(result.details).toBe(raw);
    expect(result.summary).not.toMatch(/abc-123|invalid_request_error|\{/);
  });

  it("extracts nested errors and bounds unknown summaries", () => {
    expect(presentProviderError('500: {"error":{"message":"Service unavailable","code":"overloaded"}}', "Failed").summary).toBe("Service unavailable");
    const result = presentProviderError("x".repeat(2000), "Failed");
    expect(result.summary.length).toBeLessThanOrEqual(241);
    expect(result.details).toBe("x".repeat(2000));
  });

  it("preserves billing actions and redacts details", () => {
    const result = presentProviderError("401 Insufficient balance. Manage your billing here: https://example.com/billing", "Failed");
    expect(result.summary).toBe("Insufficient balance");
    expect(result.actionUrl).toBe("https://example.com/billing");
  });

  it("does not claim that all ChatGPT accounts lack Spark access", () => {
    const result = presentProviderError("Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account", "Failed");
    expect(result.summary).toBe("This model was rejected for the current connection. Choose another model or check account access.");
  });
});
