import type { SessionSearchStatus } from "./session-search";
import type { WorkspaceIdentity } from "./workspace-identity";

export type SearchDateRange = "any" | "today" | "7d" | "30d";

export interface SessionSearchFilters {
  repository: string | null;
  branch: string | null;
  model: string | null;
  status: SessionSearchStatus | null;
  date: SearchDateRange;
}

export interface FilterableSessionHit {
  cwd: string;
  modified: string;
  modelId?: string;
  status: SessionSearchStatus;
}

export const EMPTY_SESSION_SEARCH_FILTERS: SessionSearchFilters = {
  repository: null,
  branch: null,
  model: null,
  status: null,
  date: "any",
};

export function countSessionSearchFilters(filters: SessionSearchFilters): number {
  return Number(Boolean(filters.repository))
    + Number(Boolean(filters.branch))
    + Number(Boolean(filters.model))
    + Number(Boolean(filters.status))
    + Number(filters.date !== "any");
}

export function matchesSessionSearchFilters(
  hit: FilterableSessionHit,
  identity: WorkspaceIdentity | undefined,
  filters: SessionSearchFilters,
  now = Date.now(),
): boolean {
  if (filters.repository && identity?.repository !== filters.repository) return false;
  const branch = identity?.branch ?? "not-git";
  if (filters.branch && branch !== filters.branch) return false;
  if (filters.model && hit.modelId !== filters.model) return false;
  if (filters.status && hit.status !== filters.status) return false;
  if (filters.date !== "any") {
    const modified = new Date(hit.modified).getTime();
    const start = new Date(now);
    if (filters.date === "today") start.setHours(0, 0, 0, 0);
    else start.setTime(now - (filters.date === "7d" ? 7 : 30) * 86_400_000);
    if (!Number.isFinite(modified) || modified < start.getTime()) return false;
  }
  return true;
}
