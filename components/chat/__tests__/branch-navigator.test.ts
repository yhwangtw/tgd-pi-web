import { describe, expect, it } from "vitest";
import type { SessionTreeNode } from "@/lib/types";
import { buildActivePath, hasSessionBranches } from "../BranchNavigator";

function node(id: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return {
    entry: {
      type: "session_info",
      id,
      parentId: null,
      timestamp: "2026-08-02T00:00:00.000Z",
      name: id,
    },
    children,
  };
}

describe("hasSessionBranches", () => {
  it("does not mistake a populated linear history for a branch", () => {
    expect(hasSessionBranches([node("root", [node("middle", [node("leaf")])])])).toBe(false);
  });

  it("finds a real alternate path at any depth", () => {
    expect(hasSessionBranches([
      node("root", [node("middle", [node("left"), node("right")])]),
    ])).toBe(true);
  });
});

function longHistory(size: number): SessionTreeNode {
  const root = node("0");
  let tail = root;
  for (let i = 1; i < size; i++) {
    const next = node(String(i));
    tail.children.push(next);
    tail = next;
  }
  return root;
}

it("opens a 20,000-entry linear history without recursive traversal", () => {
  const root = longHistory(20_000);
  expect(hasSessionBranches([root])).toBe(false);
  const path = buildActivePath([root], "19999");
  expect(path.size).toBe(20_000);
  expect(path.has("0")).toBe(true);
  expect(path.has("19999")).toBe(true);
  expect(buildActivePath([root], "missing").size).toBe(0);
});

it("keeps only the active branch ancestors after searching an alternate subtree", () => {
  const tree = [node("root", [longHistory(10_000), node("branch", [node("active")])])];
  expect(buildActivePath(tree, "active")).toEqual(new Set(["root", "branch", "active"]));
  expect(hasSessionBranches(tree)).toBe(true);
});
