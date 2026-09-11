import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { McpConnectionManager, mcpSignature } from "./mcp-client";
import { FileOperationError, readFileSnapshot, replaceFileSnapshot, withFileMutation, type FileSnapshot } from "./versioned-file";
import { redactedErrorMessage } from "./redaction";

export type McpTransportKind = "stdio" | "http";
export type McpScope = "global" | "project";

export interface McpServerConfig {
  id: string;
  /** Opaque read revision. Send it back when editing, toggling or deleting. */
  revision?: string;
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
  state: "disabled" | "idle" | "connecting" | "connected" | "disconnected" | "error";
  catalogChanged?: boolean;
  toolCount: number;
  tools: Array<{ name: string; title?: string; description?: string }>;
  error?: string;
  checkedAt?: string;
}

const MCP_FILENAME = "mcp-servers.json";
const MAX_MCP_SERVERS = 50;
const MAX_MCP_CONFIG_BYTES = 4 * 1024 * 1024;

export class McpConfigurationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function safeId(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `mcp-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function sanitizeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string" || item.length > 8192 || item.includes("\0"))) {
    throw new McpConfigurationError("MCP arguments must contain at most 64 strings of up to 8192 characters each");
  }
  return [...value];
}

function sanitizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32) {
    throw new McpConfigurationError("MCP headers must be an object with at most 32 entries");
  }
  const names = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || key.length > 256 || names.has(key.toLowerCase())
      || typeof item !== "string" || item.length > 8192 || /[\r\n\0]/.test(item)) {
      throw new McpConfigurationError("MCP headers require unique valid names and string values without line breaks");
    }
    names.add(key.toLowerCase());
  }
  return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}

export function validateMcpServer(input: Partial<McpServerConfig>, existing?: McpServerConfig, touchUpdated = true): McpServerConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpConfigurationError("MCP server must be an object");
  const allowed = new Set(["id", "revision", "name", "enabled", "scope", "projectCwd", "transport", "command", "args", "cwd", "url", "headers", "timeoutMs", "createdAt", "updatedAt"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new McpConfigurationError("Unknown MCP configuration field");
  const field = (key: keyof McpServerConfig, max: number) => {
    const value = input[key] === undefined ? existing?.[key] : input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new McpConfigurationError(`Invalid MCP ${key}`);
    return value.trim() || undefined;
  };
  const now = new Date().toISOString();
  const transport = input.transport === undefined ? existing?.transport ?? "stdio" : input.transport;
  const scope = input.scope === undefined ? existing?.scope ?? "global" : input.scope;
  if (transport !== "stdio" && transport !== "http") throw new McpConfigurationError("Unknown MCP transport");
  if (scope !== "global" && scope !== "project") throw new McpConfigurationError("Unknown MCP scope");
  const timeoutMs = input.timeoutMs === undefined ? existing?.timeoutMs ?? 15_000 : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new McpConfigurationError("MCP timeout must be between 1000 and 120000 milliseconds");
  }
  const name = field("name", 80);
  if (!name) throw new McpConfigurationError("MCP server name is required");
  const id = field("id", 128) ?? safeId(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new McpConfigurationError("Invalid MCP server id");
  const revision = field("revision", 128);
  const enabled = input.enabled === undefined ? existing?.enabled ?? false : input.enabled;
  if (typeof enabled !== "boolean") throw new McpConfigurationError("MCP enabled must be a boolean");
  const projectCwd = field("projectCwd", 8192);
  const cwd = field("cwd", 8192);
  if ((projectCwd && !isAbsolute(projectCwd)) || (cwd && !isAbsolute(cwd))) throw new McpConfigurationError("MCP working directories must be absolute paths");
  if (scope === "project" && !projectCwd) throw new McpConfigurationError("Project MCP server requires a project path");
  const command = field("command", 8192);
  const url = field("url", 8192);
  if (transport === "stdio" && !command) throw new McpConfigurationError("stdio MCP server requires a command");
  if (transport === "http") {
    if (!url) throw new McpConfigurationError("HTTP MCP server requires a URL");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new McpConfigurationError("MCP URL must be a valid HTTP or HTTPS URL"); }
    if (!/^https?:$/.test(parsed.protocol)) throw new McpConfigurationError("MCP URL must use HTTP or HTTPS");
    if (parsed.username || parsed.password) throw new McpConfigurationError("MCP URL must not contain credentials; use environment-backed headers");
  }
  const headers = sanitizeHeaders(input.headers === undefined ? existing?.headers : input.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (/(authorization|api[-_]?key|token|secret|cookie|password)/i.test(key) && !/^(?:[A-Za-z][A-Za-z0-9_-]*[ \t]+)?\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value)) {
      throw new McpConfigurationError(`Sensitive header ${key} must reference an environment variable such as \${MCP_TOKEN}`);
    }
  }
  for (const key of ["createdAt", "updatedAt"] as const) {
    const value = field(key, 64);
    if (value && !Number.isFinite(Date.parse(value))) throw new McpConfigurationError(`Invalid MCP ${key}`);
  }
  const createdAt = existing?.createdAt ?? (touchUpdated ? now : input.createdAt ?? new Date(0).toISOString());
  return {
    id,
    ...(revision ? { revision } : {}),
    name,
    enabled,
    scope,
    ...(projectCwd ? { projectCwd } : {}),
    transport,
    ...(command ? { command } : {}),
    args: sanitizeArgs(input.args === undefined ? existing?.args : input.args),
    ...(cwd ? { cwd } : {}),
    ...(url ? { url } : {}),
    headers,
    timeoutMs,
    createdAt,
    updatedAt: touchUpdated ? now : (input.updatedAt ?? existing?.updatedAt ?? createdAt),
  };
}

function withReadRevision(server: McpServerConfig): McpServerConfig {
  // Keep the stored nonce AND every normalized field in the read token. Manual
  // edits are detected even if they leave the nonce/timestamps untouched.
  return { ...server, revision: createHash("sha256").update(JSON.stringify([server.revision ?? null, { ...server, revision: undefined }])).digest("hex") };
}

function parseMcpFile(snapshot: FileSnapshot): McpServerConfig[] {
  if (!snapshot.exists) return [];
  let parsed: { version?: unknown; servers?: unknown };
  try { parsed = JSON.parse(snapshot.text); } catch { throw new McpConfigurationError("MCP configuration is not valid JSON; no changes were made", 503); }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.servers)
    || Object.keys(parsed).some(key => key !== "version" && key !== "servers")) {
    throw new McpConfigurationError("Unsupported MCP configuration format; no changes were made", 503);
  }
  const servers = parsed.servers.map(server => validateMcpServer(server, undefined, false));
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw new McpConfigurationError("MCP configuration contains duplicate server ids", 503);
  return servers; // Never silently drop existing records above the creation cap.
}

function configurationError(error: unknown): never {
  if (error instanceof FileOperationError) throw new McpConfigurationError(error.message, error.status);
  throw error;
}

export async function readMcpServers(): Promise<McpServerConfig[]> {
  try { return parseMcpFile(await readFileSnapshot(getAgentDir(), MCP_FILENAME, MAX_MCP_CONFIG_BYTES)).map(withReadRevision); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    configurationError(error);
  }
}

function assertRevision(existing: McpServerConfig | undefined, revision: unknown): void {
  if (!existing) {
    if (revision !== undefined) throw new McpConfigurationError("MCP configuration was removed; reload before making changes", 409);
    return;
  }
  if (typeof revision !== "string" || !revision) throw new McpConfigurationError("MCP changes require the latest revision; refresh and try again", 428);
  if (withReadRevision(existing).revision !== revision) throw new McpConfigurationError("MCP configuration changed; your draft was not saved. Reload before making changes", 409);
}

type MutationOptions = { trustStdio?: boolean; onCleanupError?: (message: string) => void };

async function mutateMcpFile<T>(change: (servers: McpServerConfig[]) => { next: McpServerConfig[] | null; result: T }): Promise<T> {
  const root = getAgentDir();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return await withFileMutation(root, MCP_FILENAME, async () => {
      const snapshot = await readFileSnapshot(root, MCP_FILENAME, MAX_MCP_CONFIG_BYTES);
      const { next, result } = change(parseMcpFile(snapshot));
      if (next) await replaceFileSnapshot(root, MCP_FILENAME, { ...snapshot, mode: 0o600 }, `${JSON.stringify({ version: 1, servers: next }, null, 2)}\n`, MAX_MCP_CONFIG_BYTES);
      return result;
    });
  } catch (error) { configurationError(error); }
}

async function invalidateAfterSave(id: string, options: MutationOptions): Promise<void> {
  try { await invalidateMcpClient(id); }
  catch (error) {
    const message = `MCP configuration was saved, but connection cleanup could not be confirmed: ${redactedErrorMessage(error)}`;
    if (options.onCleanupError) options.onCleanupError(message);
    else throw new McpConfigurationError(message, 503);
  }
}

export async function saveMcpServer(input: Partial<McpServerConfig>, options: MutationOptions = {}): Promise<McpServerConfig> {
  const saved = await mutateMcpFile(servers => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpConfigurationError("MCP server must be an object");
    const existing = input.id ? servers.find(server => server.id === input.id) : undefined;
    const validated = validateMcpServer(input, existing);
    assertRevision(existing, input.revision);
    const server = { ...validated, revision: randomUUID() };
    if (server.enabled && server.transport === "stdio" && options.trustStdio !== true) throw new McpConfigurationError("Enabling a local MCP command requires confirmation");
    if (!existing && servers.some(item => item.id === server.id)) throw new McpConfigurationError("MCP server id already exists", 409);
    if (!existing && servers.length >= MAX_MCP_SERVERS) throw new McpConfigurationError("MCP supports at most 50 saved servers; remove one before adding another", 409);
    return { next: existing ? servers.map(item => item.id === server.id ? server : item) : [...servers, server], result: withReadRevision(server) };
  });
  await invalidateAfterSave(saved.id, options);
  return saved;
}

export async function deleteMcpServer(id: string, revision?: string, options: MutationOptions = {}): Promise<boolean> {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new McpConfigurationError("Invalid MCP server id");
  const deleted = await mutateMcpFile(servers => {
    const existing = servers.find(server => server.id === id);
    assertRevision(existing, revision);
    return { next: existing ? servers.filter(server => server.id !== id) : null, result: !!existing };
  });
  if (deleted) await invalidateAfterSave(id, options);
  return deleted;
}

function registeredToolName(serverId: string, toolName: string): string {
  // Names sent to providers must fit their entire 64-character function-name
  // budget, including our namespace. Hash the ORIGINAL tuple, not its lossy
  // display slugs: punctuation, long names, and server-id aliases stay distinct.
  const digest = createHash("sha256").update(JSON.stringify([serverId, toolName])).digest("hex").slice(0, 32);
  const slug = (value: string, limit: number) => value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, limit);
  return `mcp_${slug(serverId, 12)}_${slug(toolName, 14)}_${digest}`;
}

declare global {
  var __piMcpManager: McpConnectionManager | undefined;
}

function manager(): McpConnectionManager {
  return globalThis.__piMcpManager ??= new McpConnectionManager();
}

export async function invalidateMcpClient(id: string): Promise<void> {
  await manager().invalidate(id);
}

export async function testMcpServer(server: McpServerConfig): Promise<McpServerStatus> {
  return manager().test(server);
}

export async function refreshMcpServer(server: McpServerConfig): Promise<McpServerStatus> {
  return manager().refresh(server);
}

export function getMcpStatuses(servers: McpServerConfig[]): McpServerStatus[] {
  return servers.map((server) => manager().status(server));
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
  const entry = await manager().connect(server);
  for (const tool of entry.tools) {
    const name = registeredToolName(server.id, tool.name);
    pi.registerTool(defineTool({
      name,
      label: tool.title ?? `${server.name} · ${tool.name}`,
      description: tool.description ?? `Run ${tool.name} on MCP server ${server.name}`,
      promptSnippet: `${name}: ${tool.description ?? `MCP tool from ${server.name}`}`,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        const configured = (await readMcpServers()).find((item) => item.id === server.id);
        if (!configured?.enabled || mcpSignature(configured) !== mcpSignature(server)) {
          throw new Error("MCP configuration changed or was disabled. Reload Extensions before calling this tool.");
        }
        const result = await manager().callTool(configured, tool, params as Record<string, unknown>, signal);
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
