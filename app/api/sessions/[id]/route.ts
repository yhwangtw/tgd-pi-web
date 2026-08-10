import { NextResponse } from "next/server";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  buildSessionContext,
  buildTree,
  getLeafId,
  listAllSessions,
  readSessionFile,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import type { SessionEntry, SessionHeader } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const live = getRpcSession(id);
    let filePath = await resolveSessionPath(id);
    let header: SessionHeader | null = null;
    let entries: SessionEntry[] = [];
    let readFromDisk = false;
    if (filePath) {
      try {
        ({ header, entries } = readSessionFile(filePath));
        readFromDisk = true;
      } catch {
        // Pi intentionally defers writing a new session until its first
        // assistant message. Fall through to the live in-memory manager.
      }
    }
    if (!readFromDisk && live?.isAlive() && live.sessionId === id) {
      filePath = live.sessionFile;
      header = live.inner.sessionManager.getHeader() as unknown as SessionHeader | null;
      entries = live.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    }
    if (!header) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const responseFilePath = filePath ?? live?.sessionFile ?? "";
    const tree = buildTree(entries);
    const leafId = getLeafId(entries);
    const context = buildSessionContext(entries, leafId);

    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(responseFilePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const allSessions = await listAllSessions();
    const parentSessionId = allSessions.find((s) => s.id === id)?.parentSessionId;
    const info = header ? {
      path: responseFilePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: [...entries].reverse().find((entry) => entry.type === "session_info")?.name?.trim() || undefined,
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    } : null;

    const url = new URL(req.url);
    let compactionSettings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } | undefined;
    try {
      compactionSettings = SettingsManager.create(header?.cwd ?? process.cwd()).getCompactionSettings();
    } catch {
      // Live agent state, when available, remains the authoritative fallback.
    }
    let agentState: { running: boolean; state?: unknown } | undefined;
    if (url.searchParams.has("includeState")) {
      const rpc = live;
      if (rpc?.isAlive()) {
        const state = await rpc.send({ type: "get_state" });
        agentState = { running: true, state };
      } else {
        agentState = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      filePath: responseFilePath,
      info,
      tree,
      leafId,
      context,
      ...(compactionSettings ? { compactionSettings } : {}),
      ...(agentState !== undefined ? { agentState } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read header before deleting to get parentSession path
    const firstLine = readFileSync(filePath, "utf8").split("\n")[0];
    let parentSessionPath: string | undefined;
    try {
      const header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
      if (header.type === "session") parentSessionPath = header.parentSession;
    } catch { /* ignore */ }

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (header.type === "session" && header.parentSession === filePath) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    getRpcSession(id)?.destroy();
    unlinkSync(filePath);
    invalidateSessionPathCache(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
