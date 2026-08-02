import { describe, expect, it } from "vitest";
import type { SessionTreeNode } from "@/lib/types";
import { hasSessionBranches } from "../BranchNavigator";

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
