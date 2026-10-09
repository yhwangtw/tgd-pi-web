import { resolveMigratedSessionId } from "@/lib/session-migrations";
import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Archived-session ids — same storage pattern as pins.json. Archiving hides a
// session from the default list without touching its .jsonl file.
export const dynamic = "force-dynamic";

interface ArchiveFile {
  archived: string[];
}

function getArchivePath(): string {
  return join(getAgentDir(), "archive.json");
}

function readArchive(): ArchiveFile {
  const path = getArchivePath();
  if (!existsSync(path)) return { archived: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ArchiveFile>;
    return { archived: Array.isArray(raw.archived) ? [...new Set(raw.archived.filter((x): x is string => typeof x === "string").map(resolveMigratedSessionId))] : [] };
  } catch {
    return { archived: [] };
  }
}

function writeArchive(data: ArchiveFile): void {
  const path = getArchivePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

// GET /api/sessions/archive — archived session ids.
export async function GET() {
  return NextResponse.json(readArchive());
}

// POST /api/sessions/archive  body: { id } — archive a session (idempotent).
export async function POST(req: Request) {
  try {
    const body = await req.json() as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const id = resolveMigratedSessionId(body.id);
    const { archived } = readArchive();
    if (!archived.includes(id)) {
      writeArchive({ archived: [id, ...archived] });
    }
    return NextResponse.json(readArchive());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/archive  body: { id } — unarchive.
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const id = resolveMigratedSessionId(body.id);
    const { archived } = readArchive();
    writeArchive({ archived: archived.filter((x) => x !== id) });
    return NextResponse.json(readArchive());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
