import type { SessionInfo } from "@/lib/types";

type RestoreFetcher = (url: string) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** Resolve a URL-selected session even when the incremental list is briefly stale. */
export async function resolveSessionForRestore(
  sessionId: string,
  sessions: SessionInfo[],
  fetcher: RestoreFetcher = fetch,
): Promise<SessionInfo | null> {
  const listed = sessions.find((session) => session.id === sessionId || session.sourceSessionId === sessionId);
  if (listed) return listed;

  const response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) return null;

  const payload = await response.json() as { info?: SessionInfo | null };
  return payload.info ?? null;
}
