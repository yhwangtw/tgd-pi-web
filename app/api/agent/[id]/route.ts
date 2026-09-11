import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkRequests } from "@/lib/fork-request-cache";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };

    const execute = async () => {
      // Deduplication must happen before runtime lookup: after a fork the old
      // id no longer owns the live runtime, and reopening it creates a duplicate.
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        const result = await existing.send(body);
        return NextResponse.json({ success: true, data: result });
      }

      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }

      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

      const { session } = await startRpcSession(id, filePath, cwd);
      const result = await session.send(body);

      return NextResponse.json({ success: true, data: result });
    };
    return body.type === "fork"
      ? await forkRequests.run(id, req.headers.get("Idempotency-Key"), body, execute)
      : await execute();
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
