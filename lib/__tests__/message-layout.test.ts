// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGE_LAYOUT,
  MESSAGE_LAYOUTS,
  normalizeMessageLayout,
  setMessageLayout,
} from "../message-layout";

describe("message-layout preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-message-layout");
    setMessageLayout(DEFAULT_MESSAGE_LAYOUT);
  });

  it("accepts supported layouts and rejects stale storage values", () => {
    for (const layout of MESSAGE_LAYOUTS) {
      expect(normalizeMessageLayout(layout)).toBe(layout);
    }
    expect(normalizeMessageLayout("centered")).toBe(DEFAULT_MESSAGE_LAYOUT);
    expect(normalizeMessageLayout(null)).toBe(DEFAULT_MESSAGE_LAYOUT);
  });

  it("preserves the existing split layout as the default", () => {
    expect(DEFAULT_MESSAGE_LAYOUT).toBe("split");
  });

  it("persists all-left mode and applies the document selector", () => {
    setMessageLayout("left");

    expect(localStorage.getItem("pi-message-layout")).toBe("left");
    expect(document.documentElement.getAttribute("data-message-layout")).toBe("left");
  });

  it("removes the document selector when returning to split mode", () => {
    setMessageLayout("left");
    setMessageLayout("split");

    expect(localStorage.getItem("pi-message-layout")).toBe("split");
    expect(document.documentElement.hasAttribute("data-message-layout")).toBe(false);
  });
});
