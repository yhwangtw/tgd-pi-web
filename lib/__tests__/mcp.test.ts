import { describe, expect, it } from "vitest";
import { validateMcpServer } from "../mcp";

describe("MCP configuration", () => {
  it.each([NaN, Infinity, -Infinity, 0, 999, 120001, 1000.5, null, "15000"])("rejects invalid timeout %s without silently clamping or persisting null", (timeoutMs) => {
    expect(() => validateMcpServer({ name: "Timeout", command: "node", timeoutMs: timeoutMs as number })).toThrow(/milliseconds/);
  });
  it("preserves transport and scope during partial updates", () => {
    const old = validateMcpServer({ name: "Remote", transport: "http", url: "https://example.test/mcp", scope: "project", projectCwd: "/fixture" });
    const next = validateMcpServer({ timeoutMs: 1250 }, old);
    expect(next.transport).toBe("http"); expect(next.scope).toBe("project"); expect(next.timeoutMs).toBe(1250);
  });
  it("validates local and remote transports", () => {
    expect(validateMcpServer({ name: "Files", transport: "stdio", command: "npx" }).command).toBe("npx");
    expect(validateMcpServer({ name: "Remote", transport: "http", url: "https://example.test/mcp" }).url)
      .toBe("https://example.test/mcp");
  });

  it("requires project cwd for project-scoped servers", () => {
    expect(() => validateMcpServer({ name: "Project", scope: "project", transport: "stdio", command: "node" }))
      .toThrow(/project path/);
  });

  it("requires environment indirection for sensitive headers", () => {
    expect(() => validateMcpServer({
      name: "Remote",
      transport: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer literal-secret" },
    })).toThrow(/environment variable/);
    expect(validateMcpServer({
      name: "Remote",
      transport: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer ${MCP_TOKEN}" },
    }).headers).toEqual({ Authorization: "Bearer ${MCP_TOKEN}" });
  });
});
