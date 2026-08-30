import type { SearchScope } from "@/hooks/useUnifiedSearchResults";
import { EMPTY_SESSION_SEARCH_FILTERS, type SessionSearchFilters } from "./search-filters";

export interface SavedSearchView {
  id: string;
  name: string;
  scope: SearchScope;
  query: string;
  filters: SessionSearchFilters;
  createdAt: string;
}

const STORAGE_KEY = "pi-saved-search-views:v1";
const MAX_VIEWS = 20;
const SCOPES = new Set<SearchScope>(["all", "semantic", "sessions", "files", "content", "commands"]);

function availableStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

function validFilters(value: unknown): value is SessionSearchFilters {
  if (!value || typeof value !== "object") return false;
  const filters = value as Partial<SessionSearchFilters>;
  return (filters.repository === null || typeof filters.repository === "string")
    && (filters.branch === null || typeof filters.branch === "string")
    && (filters.model === null || typeof filters.model === "string")
    && (filters.status === null || ["completed", "failed", "interrupted", "unknown"].includes(filters.status ?? ""))
    && ["any", "today", "7d", "30d"].includes(filters.date ?? "");
}

function isSavedView(value: unknown): value is SavedSearchView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<SavedSearchView>;
  return typeof view.id === "string"
    && typeof view.name === "string"
    && view.name.trim().length > 0
    && SCOPES.has(view.scope as SearchScope)
    && typeof view.query === "string"
    && validFilters(view.filters)
    && typeof view.createdAt === "string";
}

export function readSavedSearchViews(storage = availableStorage()): SavedSearchView[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSavedView).slice(0, MAX_VIEWS) : [];
  } catch {
    return [];
  }
}

export function writeSavedSearchViews(views: SavedSearchView[], storage = availableStorage()): SavedSearchView[] {
  const normalized = views.filter(isSavedView).slice(0, MAX_VIEWS);
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalized)); }
  catch { /* storage may be unavailable or full */ }
  return normalized;
}

export function createSavedSearchView(
  input: Pick<SavedSearchView, "name" | "scope" | "query" | "filters">,
  existing = readSavedSearchViews(),
  now = new Date(),
): SavedSearchView[] {
  const name = input.name.trim().slice(0, 60);
  if (!name) return existing;
  const view: SavedSearchView = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${now.getTime()}-${Math.random().toString(36).slice(2)}`,
    name,
    scope: input.scope,
    query: input.query.trim().slice(0, 500),
    filters: { ...EMPTY_SESSION_SEARCH_FILTERS, ...input.filters },
    createdAt: now.toISOString(),
  };
  return writeSavedSearchViews([view, ...existing.filter((item) => item.name.toLocaleLowerCase() !== name.toLocaleLowerCase())]);
}

export function deleteSavedSearchView(id: string, existing = readSavedSearchViews()): SavedSearchView[] {
  return writeSavedSearchViews(existing.filter((view) => view.id !== id));
}
