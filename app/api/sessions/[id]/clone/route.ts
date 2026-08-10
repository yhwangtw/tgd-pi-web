import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath, resolveSessionPath } from "@/lib/session-reader";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
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
