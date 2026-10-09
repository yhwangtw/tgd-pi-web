import { waitForSessionMigration } from "@/lib/durable-migration";
import { NextResponse } from "next/server";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { getDurableChat, openDurableChat } from "@/lib/durable-chat";
import { isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

// POST /api/agent/[id]/command - Execute an extension command
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: requestedId } = await params;
  const id = await waitForSessionMigration(requestedId);

  try {
    const body = await req.json() as { command: string; args?: string };
    const { command, args = "" } = body;

    if (typeof command !== "string" || !command || typeof args !== "string") {
      return NextResponse.json({ error: "command is required" }, { status: 400 });
    }
    if (isDurableSessionId(id)) {
      const existing = getDurableChat(id);
      if (!existing?.isAlive() && !readDurableProjection(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      const chat = existing?.isAlive() ? existing : await openDurableChat(id);
      if (!["goal", "plan"].includes(command) && !chat.getExtensionHost()?.runner.getCommand(command)) {
        return NextResponse.json({ error: `Command "${command}" not found` }, { status: 404 });
      }
      const { createSnapshot } = await import("@/lib/git-snapshot");
      await createSnapshot(chat.cwd, chat.sessionId, `Before /${command}`).catch(() => {});
      await chat.send({ type: "prompt", message: `/${command}${args ? ` ${args}` : ""}`, requestId: req.headers.get("Idempotency-Key") ?? undefined });
      return NextResponse.json({ success: true, command });
    }

    // Get or create session
    let session = getRpcSession(id);
    if (!session?.isAlive()) {
      // Try to load from file
      const { resolveSessionPath } = await import("@/lib/session-reader");
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
      const result = await startRpcSession(id, filePath, cwd);
      session = result.session;
    }

    // Get the extension runner from the inner session
    const extensionRunner = session.inner.extensionRunner;
    if (!extensionRunner) {
      return NextResponse.json({ error: "Extensions not loaded" }, { status: 500 });
    }

    // Look up the command
    const cmd = extensionRunner.getCommand(command);
    if (!cmd) {
      return NextResponse.json({ error: `Command "${command}" not found` }, { status: 404 });
    }

    // Snapshot the working tree before the command runs (tGD phases edit
    // files) so it can be rolled back later. Best-effort; no-op outside git.
    if (session.cwd) {
      const { createSnapshot } = await import("@/lib/git-snapshot");
      await createSnapshot(session.cwd, session.sessionId, `Before /${command}`).catch(() => {});
    }

    // Create command context
    const ctx = extensionRunner.createCommandContext();

    // Execute the command handler
    await cmd.handler(args, ctx);

    return NextResponse.json({ success: true, command });
  } catch (error) {
    console.error("Command execution error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
