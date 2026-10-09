import { resolveMigratedSessionId } from "@/lib/session-migrations";
import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// User-level state, not model config. Stored separately from models.json so
// that future migrations of either file don't conflict.
export const dynamic = "force-dynamic";

interface PinsFile {
  pinned: string[]; // session ids in pin order (most recent first)
}

function getPinsPath(): string {
  return join(getAgentDir(), "pins.json");
}

function readPins(): PinsFile {
  const path = getPinsPath();
  if (!existsSync(path)) return { pinned: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PinsFile>;
    return { pinned: Array.isArray(raw.pinned) ? [...new Set(raw.pinned.filter((x): x is string => typeof x === "string").map(resolveMigratedSessionId))] : [] };
  } catch {
    return { pinned: [] };
  }
}

function writePins(data: PinsFile): void {
  const path = getPinsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

// GET /api/sessions/pins — return the list of pinned session ids.
export async function GET() {
  return NextResponse.json(readPins());
}

// POST /api/sessions/pins  body: { id: string } — pin a session.
// Idempotent: pinning an already-pinned id moves it to the front of the list.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const id = resolveMigratedSessionId(body.id);
    const { pinned } = readPins();
    const next = [id, ...pinned.filter((x) => x !== id)];
    writePins({ pinned: next });
    return NextResponse.json({ pinned: next });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/pins  body: { id: string } — unpin a session.
// Idempotent: deleting an id that isn't pinned is a no-op.
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const id = resolveMigratedSessionId(body.id);
    const { pinned } = readPins();
    const next = pinned.filter((x) => x !== id);
    writePins({ pinned: next });
    return NextResponse.json({ pinned: next });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
