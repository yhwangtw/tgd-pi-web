import { afterEach, describe, expect, it } from "vitest";
import {
  consumeSensitiveAction,
  prepareSensitiveAction,
  resetSensitiveActionConfirmationsForTests,
} from "../sensitive-action-confirmation";

afterEach(() => resetSensitiveActionConfirmationsForTests());

describe("sensitive action confirmations", () => {
  it("binds a token to one exact action and consumes it once", () => {
    const prepared = prepareSensitiveAction("mcp_stdio_test", "server-a:npx:-y");
    expect(consumeSensitiveAction(prepared.token, "mcp_stdio_test", "server-b:npx:-y")).toBe(false);
    expect(consumeSensitiveAction(prepared.token, "mcp_stdio_test", "server-a:npx:-y")).toBe(false);

    const second = prepareSensitiveAction("mcp_stdio_test", "server-a:npx:-y");
    expect(consumeSensitiveAction(second.token, "mcp_stdio_test", "server-a:npx:-y")).toBe(true);
    expect(consumeSensitiveAction(second.token, "mcp_stdio_test", "server-a:npx:-y")).toBe(false);
  });

  it("cannot reuse a token across action kinds", () => {
    const prepared = prepareSensitiveAction("skill_install", "owner/repo@skill:global");
    expect(consumeSensitiveAction(prepared.token, "mcp_stdio_test", "owner/repo@skill:global")).toBe(false);
  });
});
