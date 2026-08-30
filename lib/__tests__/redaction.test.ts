import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactSensitiveText,
  redactSensitiveValue,
  redactedErrorMessage,
} from "../redaction";

describe("sensitive value redaction", () => {
  it("redacts common text credential shapes and keeps environment references", () => {
    const source = [
      "Authorization: Bearer live-token-123456789",
      "https://user:password@example.test/path?token=query-secret&mode=read",
      "GITHUB_TOKEN=github-secret-value",
      "apiKey: sk-1234567890ABCDEFGHIJ",
      "Authorization: Bearer ${MCP_TOKEN}",
    ].join("\n");
    const result = redactSensitiveText(source);

    expect(result).not.toContain("live-token-123456789");
    expect(result).not.toContain("password@example.test");
    expect(result).not.toContain("query-secret");
    expect(result).not.toContain("github-secret-value");
    expect(result).not.toContain("sk-1234567890ABCDEFGHIJ");
    expect(result).toContain(`Bearer ${REDACTED}`);
    expect(result).toContain("Bearer ${MCP_TOKEN}");
  });

  it("returns a redacted clone for nested objects without mutating input", () => {
    const source = {
      headers: { Authorization: "Bearer abcdefghijklmnop", Accept: "application/json" },
      nested: [{ refresh_token: "refresh-value", note: "safe" }],
      env: { MCP_TOKEN: "${MCP_TOKEN}", SERVICE_PASSWORD: "plain-password" },
    };
    const result = redactSensitiveValue(source);

    expect(result).toEqual({
      headers: { Authorization: REDACTED, Accept: "application/json" },
      nested: [{ refresh_token: REDACTED, note: "safe" }],
      env: { MCP_TOKEN: "${MCP_TOKEN}", SERVICE_PASSWORD: REDACTED },
    });
    expect(source.headers.Authorization).toBe("Bearer abcdefghijklmnop");
  });

  it("redacts thrown error messages", () => {
    expect(redactedErrorMessage(new Error("request failed: token=top-secret")))
      .toBe(`request failed: token=${REDACTED}`);
  });
});
