import { NextResponse } from "next/server";
import { getAllowedRoots } from "@/lib/file-security";
import { resolveSearchRoot, searchFiles } from "@/lib/search-files";
import { fileSearchOptionsFromParams } from "@/lib/file-search-options";

// GET /api/files/search?cwd=<abs>&q=<substring>
// Recursive filename search under an allowed project root. Breadth-first so
// shallow matches (usually what the user means) fill the cap before deep ones.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  if (!cwd || !q || q.length > 500) {
    return NextResponse.json({ error: "cwd and q are required" }, { status: 400 });
  }

  const root = await resolveSearchRoot(cwd, await getAllowedRoots());
  if (!root) {
    return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
  }

  return NextResponse.json(await searchFiles(root, q, { ...fileSearchOptionsFromParams(url.searchParams), signal: req.signal }));
}
