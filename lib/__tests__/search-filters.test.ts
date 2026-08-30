import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_SEARCH_FILTERS, countSessionSearchFilters, matchesSessionSearchFilters } from "../search-filters";

const identity = {
  sourceCwd: "/work/demo",
  repository: "demo",
  branch: "main",
  root: "/work/demo",
  isGit: true,
  detached: false,
};

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
});
