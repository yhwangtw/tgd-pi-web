import { NextResponse } from "next/server";
import { resolveSessionPath, listAllSessions, readSessionFile } from "@/lib/session-reader";
import { buildSessionAnalyticsReport, type AnalyticsSessionInput } from "@/lib/session-analytics";
import { durableEntries, isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    const readable: AnalyticsSessionInput[] = [];
    for (const session of sessions) {
      if (isDurableSessionId(session.id)) {
        const projection = readDurableProjection(session.id);
        if (projection) readable.push({ ...session, entries: [
          ...durableEntries(projection.entries, projection.info.created),
          ...projection.entries.filter(entry => entry.kind === "pi.compaction").map(() => ({ type: "compaction" })),
        ] as AnalyticsSessionInput["entries"] });
        continue;
      }
      const filePath = await resolveSessionPath(session.id);
      if (!filePath) continue;
      try {
        // Pure parsing/migration in memory. SessionManager.open can rewrite
        // empty/corrupt history and must never be used by a read-only report.
        const { header, entries } = readSessionFile(filePath);
        if (header?.id !== session.id) continue;
        readable.push({ ...session, entries: entries as unknown as AnalyticsSessionInput["entries"] });
      } catch { /* Skipped history is counted explicitly in the report. */ }
    }
    return NextResponse.json(buildSessionAnalyticsReport(readable, sessions.length));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
