import { NextResponse } from "next/server";
import { deleteMcpServer, getMcpStatuses, readMcpServers, refreshMcpServer, saveMcpServer, testMcpServer, validateMcpServer, type McpServerConfig } from "@/lib/mcp";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

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

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
    const servers = (await readMcpServers()).filter((server) => visibleForCwd(server, cwd));
    await Promise.allSettled(servers.filter((server) => server.enabled).map(refreshMcpServer));
    return NextResponse.json({ servers, statuses: getMcpStatuses(servers) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: "save" | "delete" | "toggle" | "test";
      server?: Partial<McpServerConfig>;
      id?: string;
      enabled?: boolean;
      trustStdio?: boolean;
      sessionId?: string;
    };
    const servers = await readMcpServers();
    const existing = body.id ? servers.find((server) => server.id === body.id) : body.server?.id ? servers.find((server) => server.id === body.server?.id) : undefined;
    if (body.action === "delete") {
      if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
      const deleted = await deleteMcpServer(body.id);
      const reload = await reloadSession(body.sessionId);
      return NextResponse.json({ ok: true, deleted, ...reload });
    }
    if (body.action === "toggle") {
      if (!existing) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
      if (body.enabled && existing.transport === "stdio" && body.trustStdio !== true) {
        return NextResponse.json({ error: "Enabling a local MCP command requires confirmation" }, { status: 400 });
      }
      const server = await saveMcpServer({ ...existing, enabled: body.enabled === true });
      const reload = await reloadSession(body.sessionId);
      return NextResponse.json({ ok: true, server, ...reload });
    }
    if (body.action === "test") {
      const candidate = body.server ? { ...existing, ...body.server } : existing;
      if (!candidate) return NextResponse.json({ error: "server is required" }, { status: 400 });
      const validated = validateMcpServer(candidate, existing);
      const status = await testMcpServer(validated);
      return NextResponse.json({ ok: true, server: validated, status });
    }
    if (body.action === "save") {
      if (!body.server) return NextResponse.json({ error: "server is required" }, { status: 400 });
      const transport = body.server.transport ?? existing?.transport ?? "stdio";
      const enabled = body.server.enabled ?? existing?.enabled ?? false;
      if (enabled && transport === "stdio" && body.trustStdio !== true) {
        return NextResponse.json({ error: "Enabling a local MCP command requires confirmation" }, { status: 400 });
      }
      const server = await saveMcpServer(body.server);
      const reload = await reloadSession(body.sessionId);
      return NextResponse.json({ ok: true, server, ...reload });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
