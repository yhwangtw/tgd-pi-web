"use client";

import type { SemanticHit } from "@/lib/semantic-search";
import type { SessionSearchStatus } from "@/lib/session-search";
import { fetchJson, useRequestResource } from "./useRequestResource";

export type SearchScope = "all" | "semantic" | "sessions" | "files" | "content" | "commands";

interface SessionMatch {
  entryId: string;
  role: string;
  text: string;
  line: number;
}

export interface SessionHit {
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  provider?: string;
  modelId?: string;
  status: SessionSearchStatus;
  score: number;
  matchedIn: "name" | "firstMessage" | "messages";
  matches: SessionMatch[];
}

export interface FileHit {
  name: string;
  relative: string;
  full: string;
  isDir: boolean;
}

export interface ContentHit {
  relative: string;
  full: string;
  line: number;
  col: number;
  text: string;
}

interface UnifiedSearchPayload {
  sessionHits: SessionHit[];
  fileHits: FileHit[];
  contentHits: ContentHit[];
  semanticHits: SemanticHit[];
  error: boolean;
}

interface UnifiedSearchResults extends UnifiedSearchPayload {
  loading: boolean;
}

const EMPTY_RESULTS: Omit<UnifiedSearchPayload, "error"> = {
  sessionHits: [],
  fileHits: [],
  contentHits: [],
  semanticHits: [],
};

/** Debounced, abortable data loading for the unified search surface. */
export function useUnifiedSearchResults(
  cwd: string | null,
  query: string,
  scope: SearchScope,
  caseSensitive: boolean,
): UnifiedSearchResults {
  const normalizedQuery = query.trim();
  const key = normalizedQuery.length >= 2
    ? `unified-search:${JSON.stringify([cwd, normalizedQuery, scope, caseSensitive])}`
    : null;
  const resource = useRequestResource<UnifiedSearchPayload>(
    key,
    async (signal) => {
      const wantsSessions = scope === "all" || scope === "sessions";
      const wantsFiles = !!cwd && (scope === "all" || scope === "files");
      const wantsContent = !!cwd && (scope === "all" || scope === "content");
      const wantsSemantic = scope === "semantic";
      const activeRequestCount = [wantsSessions, wantsFiles, wantsContent, wantsSemantic].filter(Boolean).length;
      const requests = await Promise.allSettled([
        wantsSessions
          ? fetchJson<{ hits?: SessionHit[] }>(`/api/sessions/search?q=${encodeURIComponent(normalizedQuery)}`, {}, signal)
          : Promise.resolve({ hits: [] as SessionHit[] }),
        wantsFiles
          ? fetchJson<{ results?: FileHit[] }>(`/api/files/search?cwd=${encodeURIComponent(cwd!)}&q=${encodeURIComponent(normalizedQuery)}`, {}, signal)
          : Promise.resolve({ results: [] as FileHit[] }),
        wantsContent
          ? fetchJson<{ matches?: ContentHit[] }>(`/api/files/grep?cwd=${encodeURIComponent(cwd!)}&q=${encodeURIComponent(normalizedQuery)}${caseSensitive ? "&case=1" : ""}`, {}, signal)
          : Promise.resolve({ matches: [] as ContentHit[] }),
        wantsSemantic
          ? fetchJson<{ hits?: SemanticHit[] }>(`/api/search/semantic?q=${encodeURIComponent(normalizedQuery)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`, {}, signal)
          : Promise.resolve({ hits: [] as SemanticHit[] }),
      ]);
      const [sessionsResult, filesResult, contentResult, semanticResult] = requests;
      const failures = requests.filter((result) => result.status === "rejected");
      if (signal.aborted) throw failures[0]?.status === "rejected" ? failures[0].reason : new DOMException("Search aborted", "AbortError");
      if (activeRequestCount > 0 && failures.length === activeRequestCount) throw failures[0].reason;
      return {
        sessionHits: sessionsResult.status === "fulfilled" ? sessionsResult.value.hits ?? [] : [],
        // Directories are navigated in Explorer; unified search results open
        // concrete files, so do not render inert directory rows.
        fileHits: filesResult.status === "fulfilled"
          ? (filesResult.value.results ?? []).filter((hit) => !hit.isDir)
          : [],
        contentHits: contentResult.status === "fulfilled" ? contentResult.value.matches ?? [] : [],
        semanticHits: semanticResult.status === "fulfilled" ? semanticResult.value.hits ?? [] : [],
        error: failures.some((result) => result.status === "rejected" && (result.reason as Error)?.name !== "AbortError"),
      };
    },
    { debounceMs: 250, staleTimeMs: 30_000, retries: 1 },
  );
  const results = resource.data ?? { ...EMPTY_RESULTS, error: false };
  return {
    ...results,
    loading: resource.loading || resource.refreshing,
    error: results.error || Boolean(resource.error),
  };
}
