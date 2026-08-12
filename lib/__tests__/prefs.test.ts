// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getScrollFollowMode,
  resetScrollFollowModeCache,
  setScrollFollowMode,
} from "../prefs";

describe("scroll follow preference", () => {
  beforeEach(() => {
    localStorage.clear();
    resetScrollFollowModeCache();
  });

  it("defaults to smart follow", () => {
    expect(getScrollFollowMode()).toBe("smart");
  });

  it("migrates the legacy always-follow flag", () => {
    localStorage.setItem("pi-follow-stream", "1");
    resetScrollFollowModeCache();
    expect(getScrollFollowMode()).toBe("always");
  });

  it("persists an explicit three-state preference and clears the legacy key", () => {
    localStorage.setItem("pi-follow-stream", "1");
    resetScrollFollowModeCache();
    setScrollFollowMode("preserve");
    expect(localStorage.getItem("pi-scroll-follow-mode")).toBe("preserve");
    expect(localStorage.getItem("pi-follow-stream")).toBeNull();
    expect(getScrollFollowMode()).toBe("preserve");
  });
});
