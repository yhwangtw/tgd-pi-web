import { migrateLegacySession, waitForSessionMigration } from "@/lib/durable-migration";
import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkRequests } from "@/lib/fork-request-cache";
import { getDurableChat, openDurableChat } from "@/lib/durable-chat";
import { isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: requestedId } = await params;
  let id = await waitForSessionMigration(requestedId);

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };

    const migration = body.type === "prompt" ? await migrateLegacySession(id) : undefined;
    if (migration) id = migration.sessionId;
    const execute = async () => {
      if (isDurableSessionId(id)) {
        const cached = getDurableChat(id);
        if (!cached?.isAlive() && !readDurableProjection(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
        const session = cached?.isAlive() ? cached : await openDurableChat(id);
        const requestId = req.headers.get("Idempotency-Key");
        const result = await session.send(requestId && typeof body.requestId !== "string" ? { ...body, requestId } : body);
        return NextResponse.json({ success: true, data: result, migration });
      }
      // Deduplication must happen before runtime lookup: after a fork the old
      // id no longer owns the live runtime, and reopening it creates a duplicate.
      const existing = getRpcSession(id);
      if (existing?.isAlive()) {
        const result = await existing.send(body);
        return NextResponse.json({ success: true, data: result, migration });
      }

      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }

      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

      const { session } = await startRpcSession(id, filePath, cwd);
      const result = await session.send(body);

      return NextResponse.json({ success: true, data: result, migration });
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
  const { id: requestedId } = await params;
  const id = await waitForSessionMigration(requestedId);

  try {
    if (isDurableSessionId(id)) {
      const session = getDurableChat(id);
      if (!session?.isAlive()) return NextResponse.json({ running: false });
      return NextResponse.json({ running: true, state: await session.send({ type: "get_state" }) });
    }
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
