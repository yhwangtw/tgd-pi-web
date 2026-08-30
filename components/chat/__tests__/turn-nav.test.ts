import { describe, it, expect } from "vitest";
import { pickRovingMessageTarget, pickTurnTarget } from "../turn-nav";

describe("pickTurnTarget", () => {
  // tops are viewport-relative: negative = above the viewport top
  it("next picks the first message below the viewport top", () => {
    expect(pickTurnTarget([-500, -100, 200, 900], "next")).toBe(2);
  });

  it("prev picks the last message above the viewport top", () => {
    expect(pickTurnTarget([-500, -100, 200, 900], "prev")).toBe(1);
  });

  it("ignores the message aligned at the top (within epsilon) in both directions", () => {
    // second message sits at the top after a previous jump
    expect(pickTurnTarget([-300, 0, 400], "prev")).toBe(0);
    expect(pickTurnTarget([-300, 0, 400], "next")).toBe(2);
  });

  it("returns null when there is nothing in that direction", () => {
    expect(pickTurnTarget([100, 500], "prev")).toBeNull();
    expect(pickTurnTarget([-500, -100], "next")).toBeNull();
  });

  it("handles an empty list", () => {
    expect(pickTurnTarget([], "prev")).toBeNull();
    expect(pickTurnTarget([], "next")).toBeNull();
  });
});

describe("pickRovingMessageTarget", () => {
  it("moves one message at a time", () => {
    expect(pickRovingMessageTarget(2, 5, "prev")).toBe(1);
    expect(pickRovingMessageTarget(2, 5, "next")).toBe(3);
  });

  it("supports transcript boundaries", () => {
    expect(pickRovingMessageTarget(2, 5, "first")).toBe(0);
    expect(pickRovingMessageTarget(2, 5, "last")).toBe(4);
  });

  it("does not wrap or target an empty transcript", () => {
    expect(pickRovingMessageTarget(0, 5, "prev")).toBeNull();
    expect(pickRovingMessageTarget(4, 5, "next")).toBeNull();
    expect(pickRovingMessageTarget(0, 0, "first")).toBeNull();
  });
});
