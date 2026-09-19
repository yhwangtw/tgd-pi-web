import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeSensitiveAction,
  prepareSensitiveAction,
  resetSensitiveActionConfirmationsForTests,
} from "../sensitive-action-confirmation";

afterEach(() => resetSensitiveActionConfirmationsForTests());

describe("sensitive action confirmations", () => {
  it("does not expire an unchanged review while the user is reading", () => {
    vi.useFakeTimers();
    try {
      const review = prepareSensitiveAction("snapshot_restore", "same-tree");
      vi.advanceTimersByTime(30 * 60_000);
      expect(consumeSensitiveAction(review.token, "snapshot_restore", "same-tree")).toBe(true);
    } finally { vi.useRealTimers(); }
  });
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
