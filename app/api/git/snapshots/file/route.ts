import { NextResponse } from "next/server";
import { getAllowedRoots } from "@/lib/file-security";
import { readSnapshotFile } from "@/lib/git-snapshot";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  const sessionId = url.searchParams.get("sessionId");
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");
  if (!cwd || !sessionId || !id || !path) return NextResponse.json({ error: "cwd, sessionId, id and path required" }, { status: 400 });
  const roots = await getAllowedRoots();
  if (!roots.has(cwd)) return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
  try { return NextResponse.json({ content: await readSnapshotFile(cwd, sessionId, id, path) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }); }
}
