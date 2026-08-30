import { describe, expect, it } from "vitest";
import { createOfficialMcpSeed, OFFICIAL_MCP_TEMPLATES } from "../mcp-templates";

describe("official MCP templates", () => {
  it("keeps the curated gallery uniquely identified and disabled by default", () => {
    expect(new Set(OFFICIAL_MCP_TEMPLATES.map((template) => template.id)).size).toBe(OFFICIAL_MCP_TEMPLATES.length);
    for (const template of OFFICIAL_MCP_TEMPLATES) {
      expect(createOfficialMcpSeed(template.id, "/workspace").enabled).toBe(false);
      expect(template.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("limits the filesystem reference server to the current workspace", () => {
    const seed = createOfficialMcpSeed("filesystem", "/workspace/project");
    expect(seed).toMatchObject({
      scope: "project",
      projectCwd: "/workspace/project",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/project"],
    });
  });

  it("uses the official remote documentation endpoint without a local command", () => {
    const seed = createOfficialMcpSeed("protocol-docs", null);
    expect(seed).toMatchObject({
      transport: "http",
      url: "https://modelcontextprotocol.io/mcp",
      scope: "global",
    });
    expect(seed.command).toBeUndefined();
  });
});
