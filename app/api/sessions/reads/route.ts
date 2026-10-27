import { NextResponse } from "next/server";
import { requestHasExplicitSameOrigin } from "@/lib/request-origin";
import { resolveMigratedSessionId } from "@/lib/session-migrations";
import { readSessionFile, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { getSessionReadSnapshot, saveSessionReadReceipts } from "@/lib/session-read-store";
import type { SessionReadReceipt } from "@/lib/session-read-receipt";
import type { SessionEntry } from "@/lib/types";

export async function POST(req: Request) {
  if (!requestHasExplicitSameOrigin(req)) return NextResponse.json({ error: "Same-origin request required" }, { status: 403 });
  const reader = req.body?.getReader();
  if (!reader) return NextResponse.json({ error: "Missing body" }, { status: 400 });
  let body: unknown;
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) { await reader.cancel(); return NextResponse.json({ error: "Body too large" }, { status: 413 }); }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const items = (body as { receipts?: unknown } | null)?.receipts;
  if (!Array.isArray(items) || items.length < 1 || items.length > 32 || items.some(item => (
    !item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(item.id)
    || typeof item.entryId !== "string" || !item.entryId || item.entryId.length > 256
  ))) return NextResponse.json({ error: "Invalid receipts" }, { status: 400 });
  try {
    if ((body as { scope?: unknown }).scope !== getSessionReadSnapshot().scope) {
      return NextResponse.json({ error: "Reading progress belongs to another backend" }, { status: 409 });
    }
    const updates: Record<string, SessionReadReceipt> = Object.create(null);
    const rejected: string[] = [];
    for (const { id: requestedId, entryId } of items) {
      const id = resolveMigratedSessionId(requestedId);
      const live = getRpcSession(id);
      let entries: SessionEntry[];
      if (live?.isAlive() && live.sessionId === id) {
        entries = live.inner.sessionManager.getEntries() as unknown as SessionEntry[];
      } else {
        const file = await resolveSessionPath(id);
        if (!file) { rejected.push(requestedId); continue; }
        entries = readSessionFile(file).entries;
      }
      const position = entries.findIndex(entry => entry.id === entryId);
      const entry = entries[position];
      if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message.role)) { rejected.push(requestedId); continue; }
      const timestamp = entry.message.timestamp ?? Date.parse(entry.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0) { rejected.push(requestedId); continue; }
      // Ignore client timestamps/positions. Only actual conversation content advances reads.
      const next = { entryId, timestamp, position };
      const previous = updates[id];
      if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && position > previous.position!)) updates[id] = next;
    }
    return NextResponse.json({ ...saveSessionReadReceipts(updates), rejected });
  } catch {
    return NextResponse.json({ error: "Could not save reading progress" }, { status: 500 });
  }
}
