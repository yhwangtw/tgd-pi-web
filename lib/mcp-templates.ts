import type { MsgKey } from "./i18n";
import type { McpScope, McpTransportKind } from "./mcp";

export type OfficialMcpTemplateId = "filesystem" | "memory" | "sequential-thinking" | "protocol-docs";

export interface OfficialMcpTemplate {
  id: OfficialMcpTemplateId;
  titleKey: MsgKey;
  descriptionKey: MsgKey;
  permissionKey: MsgKey;
  requirementKey: MsgKey;
  sourceUrl: string;
  transport: McpTransportKind;
  recommended?: boolean;
}

export interface McpTemplateSeed {
  name: string;
  enabled: false;
  scope: McpScope;
  projectCwd?: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export const OFFICIAL_MCP_TEMPLATES: readonly OfficialMcpTemplate[] = [
  {
    id: "filesystem",
    titleKey: "mcp.template.filesystem.title",
    descriptionKey: "mcp.template.filesystem.description",
    permissionKey: "mcp.template.filesystem.permission",
    requirementKey: "mcp.template.nodeRequirement",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    transport: "stdio",
    recommended: true,
  },
  {
    id: "memory",
    titleKey: "mcp.template.memory.title",
    descriptionKey: "mcp.template.memory.description",
    permissionKey: "mcp.template.memory.permission",
    requirementKey: "mcp.template.nodeRequirement",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    transport: "stdio",
  },
  {
    id: "sequential-thinking",
    titleKey: "mcp.template.thinking.title",
    descriptionKey: "mcp.template.thinking.description",
    permissionKey: "mcp.template.thinking.permission",
    requirementKey: "mcp.template.nodeRequirement",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    transport: "stdio",
  },
  {
    id: "protocol-docs",
    titleKey: "mcp.template.docs.title",
    descriptionKey: "mcp.template.docs.description",
    permissionKey: "mcp.template.docs.permission",
    requirementKey: "mcp.template.noLocalRequirement",
    sourceUrl: "https://modelcontextprotocol.io/mcp",
    transport: "http",
  },
] as const;

export function getOfficialMcpTemplate(id: OfficialMcpTemplateId): OfficialMcpTemplate {
  const template = OFFICIAL_MCP_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown official MCP template: ${id}`);
  return template;
}

export function createOfficialMcpSeed(id: OfficialMcpTemplateId, cwd: string | null): McpTemplateSeed {
  const projectScope = cwd ? { scope: "project" as const, projectCwd: cwd } : { scope: "global" as const };
  switch (id) {
    case "filesystem":
      return {
        name: "Filesystem",
        enabled: false,
        ...projectScope,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", cwd ?? "CHANGE_ME_TO_AN_ALLOWED_DIRECTORY"],
        timeoutMs: 20_000,
      };
    case "memory":
      return {
        name: "Memory",
        enabled: false,
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        timeoutMs: 20_000,
      };
    case "sequential-thinking":
      return {
        name: "Sequential Thinking",
        enabled: false,
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        timeoutMs: 20_000,
      };
    case "protocol-docs":
      return {
        name: "MCP Documentation",
        enabled: false,
        scope: "global",
        transport: "http",
        url: "https://modelcontextprotocol.io/mcp",
        headers: {},
        timeoutMs: 15_000,
      };
  }
}
