import { statSync } from "node:fs";
import { readAgentRunStore } from "@/lib/agent-run-store";
import type { AgentRunTranscript } from "@/lib/agent-run-types";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveMigratedSessionId } from "@/lib/session-migrations";
import { buildSessionTranscript, getLeafId, readSessionFile, resolveSessionPath } from "@/lib/session-reader";
import type { SessionEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_TRANSCRIPT_MESSAGES = 400;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = readAgentRunStore().runs.find(item => item.id === id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  try {
    let entries: SessionEntry[] = [];
    let updatedAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
    if (run.sessionId) {
      const sessionId = resolveMigratedSessionId(run.sessionId);
      const live = getRpcSession(sessionId);
      const filePath = await resolveSessionPath(sessionId);
      let readFromDisk = false;
      if (filePath) {
        try {
          entries = readSessionFile(filePath).entries;
          updatedAt = statSync(filePath).mtime.toISOString();
          readFromDisk = true;
        } catch { /* A new SDK session may not have saved its first assistant turn yet. */ }
      }
      if (!readFromDisk && live?.isAlive() && live.sessionId === sessionId) {
        entries = live.inner.sessionManager.getEntries() as unknown as SessionEntry[];
        updatedAt = new Date().toISOString();
      } else if (!readFromDisk) {
        return Response.json({ error: "Run session transcript is unavailable" }, { status: 404 });
      }
    }
    const messages = buildSessionTranscript(entries, getLeafId(entries)).messages;
    const transcript: AgentRunTranscript = {
      messages: messages.slice(-MAX_TRANSCRIPT_MESSAGES),
      truncated: messages.length > MAX_TRANSCRIPT_MESSAGES,
      updatedAt,
    };
    return Response.json(transcript, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Unable to read run transcript" }, { status: 500 });
  }
}
