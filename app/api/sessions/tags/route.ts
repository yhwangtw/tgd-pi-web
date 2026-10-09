import { resolveMigratedSessionId } from "@/lib/session-migrations";
import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

interface TagsFile {
  // Map of sessionId -> array of tag strings (lowercased, deduped)
  tags: Record<string, string[]>;
}

function getTagsPath(): string {
  return join(getAgentDir(), "tags.json");
}

function readTags(): TagsFile {
  const path = getTagsPath();
  if (!existsSync(path)) return { tags: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TagsFile>;
    const tags: Record<string, string[]> = {};
    if (raw.tags && typeof raw.tags === "object") {
      for (const [k, v] of Object.entries(raw.tags)) {
        if (Array.isArray(v)) {
          const id = resolveMigratedSessionId(k);
          tags[id] = [...new Set([...(tags[id] ?? []), ...v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase())])];
        }
      }
    }
    return { tags };
  } catch {
    return { tags: {} };
  }
}

function writeTags(data: TagsFile): void {
  const path = getTagsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function normalizeTag(t: string): string {
  return t.toLowerCase().trim().replace(/^#/, "").slice(0, 32);
}

// GET /api/sessions/tags  → { tags: { sessionId: [tag, ...] } }
export async function GET() {
  return NextResponse.json(readTags());
}

// POST /api/sessions/tags  body: { id: string, tag: string } — add tag
export async function POST(req: Request) {
  try {
    const body = await req.json() as { id?: unknown; tag?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    if (typeof body.tag !== "string" || !body.tag.trim()) {
      return NextResponse.json({ error: "tag is required" }, { status: 400 });
    }
    const id = resolveMigratedSessionId(body.id);
    const tag = normalizeTag(body.tag);
    const data = readTags();
    const existing = data.tags[id] ?? [];
    if (existing.includes(tag)) {
      return NextResponse.json({ tags: data.tags, unchanged: true });
    }
    data.tags[id] = [...existing, tag].slice(0, 16);
    writeTags(data);
    return NextResponse.json({ tags: data.tags });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/tags  body: { id: string, tag: string } — remove tag
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { id?: unknown; tag?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    if (typeof body.tag !== "string") {
      return NextResponse.json({ error: "tag is required" }, { status: 400 });
    }
    const id = resolveMigratedSessionId(body.id);
    const tag = normalizeTag(body.tag);
    const data = readTags();
    const existing = data.tags[id] ?? [];
    data.tags[id] = existing.filter((t) => t !== tag);
    if (data.tags[id].length === 0) delete data.tags[id];
    writeTags(data);
    return NextResponse.json({ tags: data.tags });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
