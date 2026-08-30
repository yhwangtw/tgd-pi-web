import { NextResponse } from "next/server";
import { getAllowedRoots } from "@/lib/file-security";
import { isGitRepo, listSnapshots, createSnapshot } from "@/lib/git-snapshot";

export const dynamic = "force-dynamic";

// GET /api/git/snapshots?cwd=…&sessionId=… — list restore points for a session.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  const sessionId = url.searchParams.get("sessionId");
  if (!cwd || !sessionId) {
    return NextResponse.json({ error: "cwd and sessionId required" }, { status: 400 });
  }
  const roots = await getAllowedRoots();
  if (!roots.has(cwd)) {
    return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
  }
  if (!(await isGitRepo(cwd))) {
    return NextResponse.json({ git: false, snapshots: [] });
  }
  return NextResponse.json({ git: true, snapshots: await listSnapshots(cwd, sessionId) });
}

// POST /api/git/snapshots  body: { cwd, sessionId, label? } — create one manually.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; sessionId?: string; label?: string };
    const { cwd, sessionId } = body;
    if (!cwd || !sessionId) {
      return NextResponse.json({ error: "cwd and sessionId required" }, { status: 400 });
    }
    const roots = await getAllowedRoots();
    if (!roots.has(cwd)) {
      return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
    }
    const snap = await createSnapshot(cwd, sessionId, body.label?.trim() || "Manual snapshot");
    if (!snap) return NextResponse.json({ git: false });
    return NextResponse.json({ git: true, snapshot: { id: snap.id, ts: snap.ts, label: snap.label, fileCount: snap.fileCount } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
