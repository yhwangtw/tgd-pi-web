import { NextResponse } from "next/server";
import { getAllowedRoots } from "@/lib/file-security";
import { resolveSearchRoot } from "@/lib/search-files";
import { fileSearchOptionsFromParams } from "@/lib/file-search-options";
import { grepProject } from "@/lib/grep";

export const dynamic = "force-dynamic";

// GET /api/files/grep?cwd=<abs>&q=<text>&case=1
// Full-text search under an allowed project root (ripgrep, JS fallback).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") ?? "";
  const q = url.searchParams.get("q") ?? "";
  const caseSensitive = url.searchParams.get("case") === "1";

  if (!cwd || !q || q.length > 500 || /[\r\n]/.test(q)) {
    return NextResponse.json({ error: "cwd and q are required" }, { status: 400 });
  }
  // Very short queries match almost everything and are slow to render — skip.
  if (q.length < 2) {
    return NextResponse.json({ matches: [], truncated: false, engine: "none" });
  }

  const root = await resolveSearchRoot(cwd, await getAllowedRoots());
  if (!root) {
    return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
  }

  try {
    return NextResponse.json(await grepProject(root, q, { caseSensitive, ...fileSearchOptionsFromParams(url.searchParams), signal: req.signal }));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
