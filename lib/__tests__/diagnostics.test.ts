import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticsValue } from "../diagnostics";

describe("diagnostics redaction", () => {
  it("masks home paths and credentials recursively", () => {
    const result = sanitizeDiagnosticsValue({
      cwd: "/Users/elon/dev/project",
      nested: { authorization: "Bearer secret-token", error: "token=another-secret in /Users/elon/.pi" },
    }, "/Users/elon");
    expect(result).toEqual({
      cwd: "~/dev/project",
      nested: { authorization: "[REDACTED]", error: "token=[REDACTED] in ~/.pi" },
    });
  });
});
