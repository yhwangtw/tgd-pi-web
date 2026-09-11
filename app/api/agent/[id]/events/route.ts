import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, getResumableRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeAgentStreamRecord, type AgentStreamRecord } from "@/lib/agent-event-log";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const cursor = req.headers.get("last-event-id") || new URL(req.url).searchParams.get("cursor");
  const resumed = cursor ? getResumableRpcSession(id, cursor) : undefined;
  // withSession/recovery must finish before exposing any replacement target.
  if (resumed?.isReplacementPending()) return new Response("Session replacement is in progress", { status: 503 });
  const moved = resumed && resumed.sessionId !== id;

  // Fast path: already-running session
  let session = resumed ?? getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
    try {
      ({ session } = await startRpcSession(id, filePath, cwd));
    } catch (error) {
      return new Response(`Failed to start agent: ${error}`, { status: 500 });
    }
  }

  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const encode = (record: AgentStreamRecord) => {
        if (closed) return;
        controller.enqueue(new TextEncoder().encode(encodeAgentStreamRecord(record)));
      };

      // Send initial connected event
      encode({ data: JSON.stringify({ type: "connected", sessionId: id }) });
      if (moved) {
        // Both the original POST result and SSE replacement event may be lost.
        // Route to the final live identity before its authoritative snapshot;
        // never replay old-session messages into the replacement transcript.
        encode({ data: JSON.stringify({ type: "session_replaced", previousSessionId: id, newSessionId: session.sessionId, cwd: session.cwd, sessionFile: session.sessionFile }) });
      }

      const unsubscribe = session.onStreamEvent((record) => {
        encode(record);
        const type = JSON.parse(record.data).type;
        if (type === "session_restart" || type === "session_closed") queueMicrotask(() => cleanup());
      }, moved ? null : cursor);

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);

      // Cleanup when client disconnects
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup, { once: true });
      if (req.signal?.aborted) cleanup();
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
