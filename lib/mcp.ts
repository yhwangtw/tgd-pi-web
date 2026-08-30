import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactedErrorMessage } from "./redaction";

export type McpTransportKind = "stdio" | "http";
export type McpScope = "global" | "project";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  scope: McpScope;
  projectCwd?: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerStatus {
  id: string;
  state: "disabled" | "connecting" | "connected" | "error";
  toolCount: number;
  tools: Array<{ name: string; title?: string; description?: string }>;
  error?: string;
  checkedAt?: string;
}

interface McpFile { version: 1; servers: McpServerConfig[] }

const MCP_PATH = () => join(getAgentDir(), "mcp-servers.json");

function safeId(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `mcp-${Date.now().toString(36)}`;
}

function sanitizeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 64);
}

function sanitizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === "string")
    .slice(0, 32));
}

export function validateMcpServer(input: Partial<McpServerConfig>, existing?: McpServerConfig, touchUpdated = true): McpServerConfig {
  const now = new Date().toISOString();
  const transport: McpTransportKind = input.transport === "http" ? "http" : "stdio";
  const scope: McpScope = input.scope === "project" ? "project" : "global";
  const name = String(input.name ?? existing?.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("MCP server name is required");
  const id = safeId(String(input.id ?? existing?.id ?? name));
  const projectCwd = String(input.projectCwd ?? existing?.projectCwd ?? "").trim() || undefined;
  if (scope === "project" && !projectCwd) throw new Error("Project MCP server requires a project path");
  const command = String(input.command ?? existing?.command ?? "").trim() || undefined;
  const url = String(input.url ?? existing?.url ?? "").trim() || undefined;
  if (transport === "stdio" && !command) throw new Error("stdio MCP server requires a command");
  if (transport === "http") {
    if (!url) throw new Error("HTTP MCP server requires a URL");
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("MCP URL must use HTTP or HTTPS");
  }
  const headers = sanitizeHeaders(input.headers ?? existing?.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (/(authorization|api[-_]?key|token|secret)/i.test(key) && !/\$\{[A-Z_][A-Z0-9_]*\}/i.test(value)) {
      throw new Error(`Sensitive header ${key} must reference an environment variable such as \${MCP_TOKEN}`);
    }
  }
  return {
    id,
    name,
    enabled: input.enabled ?? existing?.enabled ?? false,
    scope,
    ...(projectCwd ? { projectCwd } : {}),
    transport,
    ...(command ? { command } : {}),
    args: sanitizeArgs(input.args ?? existing?.args),
    ...(String(input.cwd ?? existing?.cwd ?? "").trim() ? { cwd: String(input.cwd ?? existing?.cwd).trim() } : {}),
    ...(url ? { url } : {}),
    headers,
    timeoutMs: Math.max(1_000, Math.min(120_000, Number(input.timeoutMs ?? existing?.timeoutMs ?? 15_000))),
    createdAt: existing?.createdAt ?? now,
    updatedAt: touchUpdated ? now : (input.updatedAt ?? existing?.updatedAt ?? now),
  };
}

export async function readMcpServers(): Promise<McpServerConfig[]> {
  try {
    const parsed = JSON.parse(await readFile(MCP_PATH(), "utf8")) as Partial<McpFile>;
    if (!Array.isArray(parsed.servers)) return [];
    return parsed.servers.slice(0, 50).map((server) => validateMcpServer(server, server, false));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeMcpServers(servers: McpServerConfig[]): Promise<void> {
  const path = MCP_PATH();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function saveMcpServer(input: Partial<McpServerConfig>): Promise<McpServerConfig> {
  const servers = await readMcpServers();
  const existing = input.id ? servers.find((server) => server.id === input.id) : undefined;
  const server = validateMcpServer(input, existing);
  if (!existing && servers.some((item) => item.id === server.id)) throw new Error(`MCP server id already exists: ${server.id}`);
  const next = existing ? servers.map((item) => item.id === server.id ? server : item) : [...servers, server];
  await writeMcpServers(next);
  await invalidateMcpClient(server.id);
  return server;
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const servers = await readMcpServers();
  const next = servers.filter((server) => server.id !== id);
  if (next.length === servers.length) return false;
  await writeMcpServers(next);
  await invalidateMcpClient(id);
  return true;
}

function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, key: string) => {
    const resolved = process.env[key];
    if (resolved === undefined) throw new Error(`Missing environment variable: ${key}`);
    return resolved;
  });
}

function toolPrefix(server: McpServerConfig): string {
  return `mcp_${safeId(server.id).replace(/-/g, "_")}`;
}

function safeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64);
}

type McpClientEntry = {
  signature: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
};

declare global {
  var __piMcpClients: Map<string, McpClientEntry> | undefined;
  var __piMcpStatus: Map<string, McpServerStatus> | undefined;
}

function clients(): Map<string, McpClientEntry> {
  return globalThis.__piMcpClients ??= new Map();
}

function statuses(): Map<string, McpServerStatus> {
  return globalThis.__piMcpStatus ??= new Map();
}

function signature(server: McpServerConfig): string {
  return JSON.stringify({ ...server, createdAt: undefined, updatedAt: undefined });
}

async function connectMcp(server: McpServerConfig, force = false): Promise<McpClientEntry> {
  const current = clients().get(server.id);
  const nextSignature = signature(server);
  if (!force && current?.signature === nextSignature) return current;
  if (current) await invalidateMcpClient(server.id);
  statuses().set(server.id, { id: server.id, state: "connecting", toolCount: 0, tools: [] });
  try {
    const client = new Client({ name: "tgd-pi-web", version: "1" }, { capabilities: {} });
    const transport = server.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url!), {
          requestInit: { headers: Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, interpolate(value)])) },
        })
      : new StdioClientTransport({
          command: server.command!,
          args: (server.args ?? []).map(interpolate),
          ...(server.cwd ? { cwd: server.cwd } : {}),
          stderr: "pipe",
        });
    await client.connect(transport, { timeout: server.timeoutMs });
    const listed = await client.listTools(undefined, { timeout: server.timeoutMs });
    const entry: McpClientEntry = { signature: nextSignature, client, transport, tools: listed.tools };
    clients().set(server.id, entry);
    statuses().set(server.id, {
      id: server.id,
      state: "connected",
      toolCount: listed.tools.length,
      tools: listed.tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
      checkedAt: new Date().toISOString(),
    });
    return entry;
  } catch (error) {
    const message = redactedErrorMessage(error);
    statuses().set(server.id, { id: server.id, state: "error", toolCount: 0, tools: [], error: message, checkedAt: new Date().toISOString() });
    throw new Error(message, { cause: error });
  }
}

export async function invalidateMcpClient(id: string): Promise<void> {
  const entry = clients().get(id);
  clients().delete(id);
  statuses().delete(id);
  if (entry) await entry.transport.close().catch(() => undefined);
}

export async function testMcpServer(server: McpServerConfig): Promise<McpServerStatus> {
  await connectMcp(server, true);
  return statuses().get(server.id)!;
}

export async function refreshMcpServer(server: McpServerConfig): Promise<McpServerStatus> {
  await connectMcp(server);
  return statuses().get(server.id)!;
}

export function getMcpStatuses(servers: McpServerConfig[]): McpServerStatus[] {
  return servers.map((server) => {
    if (!server.enabled) return { id: server.id, state: "disabled", toolCount: 0, tools: [] };
    return statuses().get(server.id) ?? { id: server.id, state: "connecting", toolCount: 0, tools: [] };
  });
}

type McpCallResult = {
  content?: unknown;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function resultContent(result: McpCallResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const rawItem of Array.isArray(result.content) ? result.content : []) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
    else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
      const resource = item.resource as Record<string, unknown>;
      content.push({ type: "text", text: `Resource ${String(resource.uri ?? "")}\n${typeof resource.text === "string" ? resource.text : "[binary resource]"}` });
    } else if (item.type === "resource_link") content.push({ type: "text", text: `Resource link: ${String(item.name ?? "resource")} (${String(item.uri ?? "")})` });
    else if (item.type === "audio") content.push({ type: "text", text: `[Audio result: ${String(item.mimeType ?? "unknown")}]` });
  }
  if (!content.length && result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  return content.length ? content : [{ type: "text", text: "MCP tool completed without output." }];
}

async function registerServerTools(pi: ExtensionAPI, server: McpServerConfig): Promise<void> {
  const entry = await connectMcp(server);
  for (const tool of entry.tools) {
    const name = `${toolPrefix(server)}_${safeToolName(tool.name)}`;
    pi.registerTool(defineTool({
      name,
      label: tool.title ?? `${server.name} · ${tool.name}`,
      description: tool.description ?? `Run ${tool.name} on MCP server ${server.name}`,
      promptSnippet: `${name}: ${tool.description ?? `MCP tool from ${server.name}`}`,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        const result = await entry.client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, {
          timeout: server.timeoutMs,
          ...(signal ? { signal } : {}),
        });
        const content = resultContent(result as unknown as McpCallResult);
        if (result.isError === true) {
          const message = content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n")
            .trim();
          throw new Error(message || `${server.name} · ${tool.name} failed`);
        }
        return {
          content,
          details: { serverId: server.id, serverName: server.name, toolName: tool.name, isError: false, structuredContent: result.structuredContent },
        };
      },
    }));
  }
}

export function createMcpExtension(cwd: string): InlineExtension {
  return {
    name: "pi-web-mcp",
    factory: async (pi) => {
      const servers = (await readMcpServers()).filter((server) => server.enabled && (server.scope === "global" || server.projectCwd === cwd));
      await Promise.all(servers.map(async (server) => {
        try {
          await registerServerTools(pi, server);
        } catch {
          // Connection state is exposed in the MCP center. One unavailable
          // server must not prevent the rest of Pi's extensions from loading.
        }
      }));
    },
  };
}
