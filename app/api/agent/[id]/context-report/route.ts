import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { buildContextReport } from "@/lib/context-report";

export const dynamic = "force-dynamic";

async function ensureSession(id: string): Promise<AgentSessionWrapper | null> {
  const existing = getRpcSession(id);
  if (existing?.isAlive()) return existing;
  const filePath = await resolveSessionPath(id);
  if (!filePath) return null;
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  const { session } = await startRpcSession(id, filePath, cwd);
  return session;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await ensureSession(id);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(buildContextReport(session.inner, session.cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
