import { waitForSessionMigration } from "@/lib/durable-migration";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath, resolveSessionPath } from "@/lib/session-reader";
import { getDurableChat, openDurableChat } from "@/lib/durable-chat";
import { durableSessionData, isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: requestedId } = await params;
  const id = await waitForSessionMigration(requestedId);
  if (isDurableSessionId(id)) {
    const live = getDurableChat(id);
    const projection = live?.isAlive() ? live.getProjection() : readDurableProjection(id);
    if (!projection) return Response.json({ error: "Session not found" }, { status: 404 });
    if (!durableSessionData(projection).leafId) return Response.json({ error: "Cannot clone an empty session" }, { status: 409 });
    try {
      const clone = await (live?.isAlive() ? live : await openDurableChat(id)).fork();
      return Response.json({ sessionId: clone.sessionId, sessionFile: clone.sessionFile, cwd: clone.cwd }, { status: 201 });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
  }
  const sourcePath = await resolveSessionPath(id);
  if (!sourcePath) return Response.json({ error: "Session not found" }, { status: 404 });
  try {
    const source = SessionManager.open(sourcePath);
    const leafId = source.getLeafId();
    if (!leafId) return Response.json({ error: "Cannot clone an empty session" }, { status: 409 });
    const sessionFile = source.createBranchedSession(leafId);
    if (!sessionFile) return Response.json({ error: "Session persistence is unavailable" }, { status: 409 });
    const clone = SessionManager.open(sessionFile);
    const sessionId = clone.getSessionId();
    cacheSessionPath(sessionId, sessionFile);
    return Response.json({ sessionId, sessionFile, cwd: clone.getCwd() }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
