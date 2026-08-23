import { describe, expect, it } from "vitest";
import { validateMcpServer } from "../mcp";

describe("MCP configuration", () => {
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
