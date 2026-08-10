"use client";

import { useEffect, useState } from "react";
import type { SemanticHit } from "@/lib/semantic-search";

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

interface UnifiedSearchResults {
  sessionHits: SessionHit[];
  fileHits: FileHit[];
  contentHits: ContentHit[];
  semanticHits: SemanticHit[];
  loading: boolean;
  error: boolean;
}

const EMPTY_RESULTS: Omit<UnifiedSearchResults, "loading" | "error"> = {
  sessionHits: [],
  fileHits: [],
  contentHits: [],
  semanticHits: [],
};

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  return response.json() as Promise<T>;
}

/** Debounced, abortable data loading for the unified search surface. */
export function useUnifiedSearchResults(
  cwd: string | null,
  query: string,
  scope: SearchScope,
  caseSensitive: boolean,
): UnifiedSearchResults {
  const [results, setResults] = useState<UnifiedSearchResults>({
    ...EMPTY_RESULTS,
    loading: false,
    error: false,
  });

  useEffect(() => {
    if (query.length < 2) {
      setResults({ ...EMPTY_RESULTS, loading: false, error: false });
      return;
    }

    const controller = new AbortController();
    let alive = true;
    setResults((current) => ({ ...current, loading: true, error: false }));

    const timer = setTimeout(async () => {
      const wantsSessions = scope === "all" || scope === "sessions";
      const wantsFiles = !!cwd && (scope === "all" || scope === "files");
      const wantsContent = !!cwd && (scope === "all" || scope === "content");
      const wantsSemantic = scope === "semantic";
      const requests = await Promise.allSettled([
        wantsSessions
          ? fetchJson<{ hits?: SessionHit[] }>(`/api/sessions/search?q=${encodeURIComponent(query)}`, controller.signal)
          : Promise.resolve({ hits: [] as SessionHit[] }),
        wantsFiles
          ? fetchJson<{ results?: FileHit[] }>(`/api/files/search?cwd=${encodeURIComponent(cwd!)}&q=${encodeURIComponent(query)}`, controller.signal)
          : Promise.resolve({ results: [] as FileHit[] }),
        wantsContent
          ? fetchJson<{ matches?: ContentHit[] }>(`/api/files/grep?cwd=${encodeURIComponent(cwd!)}&q=${encodeURIComponent(query)}${caseSensitive ? "&case=1" : ""}`, controller.signal)
          : Promise.resolve({ matches: [] as ContentHit[] }),
        wantsSemantic
          ? fetchJson<{ hits?: SemanticHit[] }>(`/api/search/semantic?q=${encodeURIComponent(query)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`, controller.signal)
          : Promise.resolve({ hits: [] as SemanticHit[] }),
      ]);

      if (!alive) return;
      const [sessionsResult, filesResult, contentResult, semanticResult] = requests;
      setResults({
        sessionHits: sessionsResult.status === "fulfilled" ? sessionsResult.value.hits ?? [] : [],
        // Directories are navigated in Explorer; unified search results open
        // concrete files, so do not render inert directory rows.
        fileHits: filesResult.status === "fulfilled"
          ? (filesResult.value.results ?? []).filter((hit) => !hit.isDir)
          : [],
        contentHits: contentResult.status === "fulfilled" ? contentResult.value.matches ?? [] : [],
        semanticHits: semanticResult.status === "fulfilled" ? semanticResult.value.hits ?? [] : [],
        error: requests.some((result) => result.status === "rejected" && (result.reason as Error)?.name !== "AbortError"),
        loading: false,
      });
    }, 250);

    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope, cwd, caseSensitive]);

  return results;
}
