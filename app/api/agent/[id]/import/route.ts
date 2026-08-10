import { NextResponse } from "next/server";
import { getAllowedRoots } from "@/lib/file-security";
import { getRpcSession, SessionRuntimeConflictError, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { inspectSessionImport, SessionImportValidationError } from "@/lib/session-import";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

async function ensureSession(id: string): Promise<AgentSessionWrapper | null> {
  const existing = getRpcSession(id);
  if (existing?.isAlive()) return existing;
  const filePath = await resolveSessionPath(id);
  if (!filePath) return null;
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  return (await startRpcSession(id, filePath, cwd)).session;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { action?: "preview" | "import"; path?: string; cwdOverride?: string };
    if (body.action !== "preview" && body.action !== "import") {
      return NextResponse.json({ error: "action must be preview or import" }, { status: 400 });
    }
    if (typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const session = await ensureSession(id);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const preview = await inspectSessionImport(
      body.path,
      await getAllowedRoots(),
      session.inner.sessionManager.getSessionDir(),
      typeof body.cwdOverride === "string" && body.cwdOverride.trim() ? body.cwdOverride : undefined,
    );
    if (preview.sessionId === session.sessionId && preview.sourcePath !== session.sessionFile) {
      return NextResponse.json({ error: "The imported session id matches the active session" }, { status: 409 });
    }
    if (body.action === "preview") return NextResponse.json({ preview });

    const result = await session.importSession(
      preview.sourcePath,
      preview.cwd === preview.headerCwd ? undefined : preview.cwd,
    );
    return NextResponse.json({ preview, result });
  } catch (error) {
    if (error instanceof SessionImportValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SessionRuntimeConflictError) {
      return NextResponse.json({ error: error.message, targetSessionId: error.targetSessionId }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
