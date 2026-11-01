import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getSessionSearchIndex } from "@/lib/session-search-index";
import { scoreSessionSearchHit, searchPreparedSession, type SessionSearchMatch, type SessionSearchStatus } from "@/lib/session-search";

export const dynamic = "force-dynamic";

interface SearchHit {
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  created: string;
  modified: string;
  messageCount: number;
  provider?: string;
  modelId?: string;
  status: SessionSearchStatus;
  matchedIn: "name" | "firstMessage" | "messages";
  matches: SessionSearchMatch[];
  totalMatches: number;
  score: number;
}

// Search all sessions: name + firstMessage + all message contents.
// Scans up to 500 most-recent sessions (300 by default); older sessions are
// skipped with a `truncated` flag in the response.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "300", 10) || 300, 500);
    const resultLimit = Math.min(parseInt(url.searchParams.get("resultLimit") ?? "100", 10) || 100, 200);

    if (q.length < 1) {
      return NextResponse.json({ hits: [], truncated: false, query: q });
    }

    const all = await listAllSessions();
    const index = getSessionSearchIndex(all.map(session => session.path));
    // Most-recent first
    all.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    const slice = all.slice(0, limit);
    const truncated = all.length > slice.length;

    const needle = q.toLowerCase();
    const hits: SearchHit[] = [];

    for (const s of slice) {
      let matchedIn: SearchHit["matchedIn"] = "messages";

      // 1. Check session name
      if (s.name?.toLowerCase().includes(needle)) {
        matchedIn = "name";
      }

      // 2. Check firstMessage
      if (matchedIn === "messages" && s.firstMessage.toLowerCase().includes(needle)) {
        matchedIn = "firstMessage";
      }

      // 3. Reuse compact searchable text for unchanged files across queries.
      const data = await index.read(s.path);
      if (!data) continue;
      const matches = searchPreparedSession(data, needle);

      if (matches.length > 0 || matchedIn !== "messages") {
        const metadata = data.metadata;
        hits.push({
          id: s.id,
          cwd: s.cwd,
          name: s.name,
          firstMessage: s.firstMessage,
          created: s.created,
          modified: s.modified,
          messageCount: s.messageCount,
          provider: metadata.provider,
          modelId: metadata.modelId,
          status: metadata.status,
          matchedIn,
          matches,
          totalMatches: matches.length,
          score: scoreSessionSearchHit({
            name: s.name,
            firstMessage: s.firstMessage,
            query: needle,
            matchCount: matches.length,
            modified: s.modified,
          }),
        });
      }
    }

    // Title/opening-prompt relevance wins; match count and recency break ties.
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });

    return NextResponse.json({
      hits: hits.slice(0, resultLimit),
      totalHits: hits.length,
      resultsLimited: hits.length > resultLimit,
      truncated,
      query: q,
      scanned: slice.length,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
