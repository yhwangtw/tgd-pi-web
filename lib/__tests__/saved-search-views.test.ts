// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { createSavedSearchView, deleteSavedSearchView, readSavedSearchViews, writeSavedSearchViews } from "../saved-search-views";
import { EMPTY_SESSION_SEARCH_FILTERS } from "../search-filters";

describe("saved search views", () => {
  beforeEach(() => localStorage.clear());

  it("persists query, scope, and conversation filters", () => {
    const views = createSavedSearchView({
      name: "Failed this week",
      scope: "sessions",
      query: "billing",
      filters: { ...EMPTY_SESSION_SEARCH_FILTERS, repository: "tgd-pi-web", status: "failed", date: "7d" },
    });
    expect(views[0]).toMatchObject({ name: "Failed this week", scope: "sessions", query: "billing" });
    expect(readSavedSearchViews()[0]?.filters).toMatchObject({ repository: "tgd-pi-web", status: "failed", date: "7d" });
  });

  it("replaces duplicate names and removes a saved view", () => {
    let views = createSavedSearchView({ name: "Recent", scope: "all", query: "first", filters: EMPTY_SESSION_SEARCH_FILTERS });
    views = createSavedSearchView({ name: "recent", scope: "sessions", query: "second", filters: EMPTY_SESSION_SEARCH_FILTERS }, views);
    expect(views).toHaveLength(1);
    expect(views[0]?.query).toBe("second");
    expect(deleteSavedSearchView(views[0]!.id, views)).toEqual([]);
  });

  it("ignores malformed stored data", () => {
    localStorage.setItem("pi-saved-search-views:v1", JSON.stringify([{ id: "bad" }]));
    expect(readSavedSearchViews()).toEqual([]);
    expect(writeSavedSearchViews([])).toEqual([]);
  });
});
