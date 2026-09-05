import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_SEARCH_FILTERS, countSessionSearchFilters, matchesSessionSearchFilters } from "../search-filters";
import { pendingWorkspaceIdentity, resolveWorkspaceIdentity } from "../workspace-identity";

const identity = resolveWorkspaceIdentity("/work/demo", [
  { path: "/work/demo", branch: "main", head: "abcdef123456", isMain: true },
]);

const hit = { cwd: "/work/demo", modified: "2026-08-29T10:00:00.000Z", modelId: "gpt-5", status: "completed" as const };

describe("session search filters", () => {
  it("matches repository, branch, model, status and date together", () => {
    const filters = { repository: "demo", branch: "main", model: "gpt-5", status: "completed" as const, date: "7d" as const };
    expect(countSessionSearchFilters(filters)).toBe(5);
    expect(matchesSessionSearchFilters(hit, identity, filters, new Date("2026-08-30T10:00:00Z").getTime())).toBe(true);
    expect(matchesSessionSearchFilters(hit, identity, { ...filters, branch: "release" }, new Date("2026-08-30T10:00:00Z").getTime())).toBe(false);
  });

  it("leaves results untouched when filters are empty", () => {
    expect(countSessionSearchFilters(EMPTY_SESSION_SEARCH_FILTERS)).toBe(0);
    expect(matchesSessionSearchFilters(hit, identity, EMPTY_SESSION_SEARCH_FILTERS)).toBe(true);
  });

  it("does not label loading or unavailable Git metadata as a non-repository", () => {
    const filters = { ...EMPTY_SESSION_SEARCH_FILTERS, branch: "not-git" };
    for (const unknown of [undefined, pendingWorkspaceIdentity(hit.cwd), pendingWorkspaceIdentity(hit.cwd, "unknown")]) {
      expect(matchesSessionSearchFilters(hit, unknown, filters)).toBe(false);
    }
    expect(matchesSessionSearchFilters(hit, resolveWorkspaceIdentity(hit.cwd, []), filters)).toBe(true);
  });
});
