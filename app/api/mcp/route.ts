import { NextResponse } from "next/server";
import { redactedErrorMessage } from "@/lib/redaction";
import { deleteMcpServer, getMcpStatuses, McpConfigurationError, readMcpServers, refreshMcpServer, saveMcpServer, testMcpServer, validateMcpServer, type McpServerConfig } from "@/lib/mcp";
import { getRpcSession } from "@/lib/rpc-manager";
import { consumeSensitiveAction, prepareSensitiveAction } from "@/lib/sensitive-action-confirmation";
import { recordSecurityActivity, type SecurityActivityOutcome } from "@/lib/security-activity";

export const dynamic = "force-dynamic";

class McpRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin") || new URL(origin).host !== new URL(req.url).host) {
    throw new McpRequestError("MCP changes require a same-origin browser request", 403);
  }
}

function visibleForCwd(server: McpServerConfig, cwd?: string): boolean {
  return server.scope === "global" || !cwd || server.projectCwd === cwd;
}

async function reloadSession(sessionId?: string): Promise<{ reloaded: boolean; deferred: boolean }> {
  if (!sessionId) return { reloaded: false, deferred: false };
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) return { reloaded: false, deferred: false };
  if (session.inner.isStreaming || session.inner.isCompacting) return { reloaded: false, deferred: true };
  await session.reloadExtensions();
  return { reloaded: true, deferred: false };
}

function stdioTestFingerprint(server: McpServerConfig): string {
  return JSON.stringify({
    id: server.id,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd ?? "",
    timeoutMs: server.timeoutMs,
  });
}

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
    const servers = (await readMcpServers()).filter((server) => visibleForCwd(server, cwd));
    await Promise.allSettled(servers.filter((server) => server.enabled).map(refreshMcpServer));
    return NextResponse.json({ servers, statuses: getMcpStatuses(servers) });
  } catch (error) {
    return NextResponse.json({ error: redactedErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let activity: { action: string; target?: string; sessionId?: string } | null = null;
  try {
    assertSameOrigin(req);
    const body = await req.json() as {
      action?: "save" | "delete" | "toggle" | "test";
      phase?: "prepare" | "execute";
      server?: Partial<McpServerConfig>;
      id?: string;
      enabled?: boolean;
      trustStdio?: boolean;
      confirmationToken?: string;
      sessionId?: string;
    };
    const servers = await readMcpServers();
    const existing = body.id ? servers.find((server) => server.id === body.id) : body.server?.id ? servers.find((server) => server.id === body.server?.id) : undefined;
    const action = body.action ?? "unknown";
    const target = body.server?.name ?? existing?.name ?? body.id;
    activity = { action, target, sessionId: body.sessionId };
    const audit = (outcome: SecurityActivityOutcome, summary: string, details?: Record<string, unknown>) => {
      recordSecurityActivity({
        category: "mcp",
        action,
        outcome,
        summary,
        target,
        sessionId: body.sessionId,
        cwd: existing?.projectCwd ?? body.server?.projectCwd,
        details,
      });
    };
    const deny = (message: string, status: number) => {
      audit("denied", message);
      return NextResponse.json({ error: message }, { status });
    };
    if (body.action === "delete") {
      if (!body.id) return deny("id is required", 400);
      const deleted = await deleteMcpServer(body.id);
      const reload = await reloadSession(body.sessionId);
      audit("success", "MCP server removed", { deleted, reload });
      return NextResponse.json({ ok: true, deleted, ...reload });
    }
    if (body.action === "toggle") {
      if (!existing) return deny("MCP server not found", 404);
      if (body.enabled && existing.transport === "stdio" && body.trustStdio !== true) {
        return deny("Enabling a local MCP command requires confirmation", 400);
      }
      const server = await saveMcpServer({ ...existing, enabled: body.enabled === true });
      const reload = await reloadSession(body.sessionId);
      audit("success", body.enabled ? "MCP server enabled" : "MCP server disabled", {
        transport: server.transport,
        scope: server.scope,
        reload,
      });
      return NextResponse.json({ ok: true, server, ...reload });
    }
    if (body.action === "test") {
      const candidate = body.server ? { ...existing, ...body.server } : existing;
      if (!candidate) return deny("server is required", 400);
      const validated = validateMcpServer(candidate, existing);
      if (validated.transport === "stdio") {
        const fingerprint = stdioTestFingerprint(validated);
        if (body.phase === "prepare") {
          audit("reviewed", "Local MCP test reviewed", {
            transport: validated.transport,
            command: validated.command,
            args: validated.args ?? [],
            cwd: validated.cwd,
          });
          return NextResponse.json({
            confirmation: prepareSensitiveAction("mcp_stdio_test", fingerprint),
            review: {
              id: validated.id,
              name: validated.name,
              command: validated.command,
              args: validated.args ?? [],
              cwd: validated.cwd ?? null,
            },
          });
        }
        if (body.phase !== "execute"
          || typeof body.confirmationToken !== "string"
          || !consumeSensitiveAction(body.confirmationToken, "mcp_stdio_test", fingerprint)) {
          return deny("Local MCP command confirmation expired; review the command again", 409);
        }
      }
      const status = await testMcpServer(validated);
      audit("success", "MCP connection test completed", {
        transport: validated.transport,
        state: status.state,
        toolCount: status.toolCount,
      });
      return NextResponse.json({ ok: true, server: validated, status });
    }
    if (body.action === "save") {
      if (!body.server) return deny("server is required", 400);
      const transport = body.server.transport ?? existing?.transport ?? "stdio";
      const enabled = body.server.enabled ?? existing?.enabled ?? false;
      if (enabled && transport === "stdio" && body.trustStdio !== true) {
        return deny("Enabling a local MCP command requires confirmation", 400);
      }
      const server = await saveMcpServer(body.server);
      const reload = await reloadSession(body.sessionId);
      audit("success", existing ? "MCP server updated" : "MCP server added", {
        transport: server.transport,
        scope: server.scope,
        enabled: server.enabled,
        reload,
      });
      return NextResponse.json({ ok: true, server, ...reload });
    }
    return deny("Unknown action", 400);
  } catch (error) {
    recordSecurityActivity({
      category: "mcp",
      action: activity?.action ?? "request",
      outcome: "failure",
      summary: redactedErrorMessage(error),
      target: activity?.target,
      sessionId: activity?.sessionId,
    });
    return NextResponse.json(
      { error: redactedErrorMessage(error) },
      { status: error instanceof McpRequestError ? error.status : error instanceof McpConfigurationError ? 400 : 500 },
    );
  }
}
