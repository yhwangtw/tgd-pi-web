import { NextResponse } from "next/server";
import { resolveSessionPath, buildSessionContext, getSessionEntries } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import type { SessionEntry } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;

  try {
    const live = getRpcSession(id);
    const filePath = await resolveSessionPath(id);
    let entries: SessionEntry[] | null = null;
    if (filePath) {
      try {
        entries = getSessionEntries(filePath);
      } catch {
        // An unflushed live session has a future file path but no file yet.
      }
    }
    if (!entries && live?.isAlive() && live.sessionId === id) {
      entries = live.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    }
    if (!entries) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const context = buildSessionContext(entries, leafId);

    return NextResponse.json({ context });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
