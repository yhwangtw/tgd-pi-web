import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionTreeNode } from "../types";
import { decodeSessionData, decodeSessionTree, encodeSessionData, encodeSessionTree } from "../session-tree-wire";

function node(id: string, parentId: string | null = null): SessionTreeNode {
  return { entry: { type: "message", id, parentId, timestamp: "2026-10-22T00:00:00Z", message: { role: "user", content: id, timestamp: 1 } }, children: [] };
}

describe("session tree transport", () => {
  it("round trips 20,000 sequential nodes through JSON without truncating history", () => {
    const root = node("0"); let current = root;
    for (let i = 1; i < 20_000; i++) { const next = node(String(i), String(i - 1)); current.children.push(next); current = next; }
    const wire = encodeSessionData({ tree: [root], leafId: "19999", context: { messages: ["unchanged"] } });
    const restored = decodeSessionData(JSON.parse(JSON.stringify(wire)));
    let count = 0; let leaf: SessionEntry | undefined;
    for (let current: SessionTreeNode | undefined = restored.tree[0]; current; current = current.children[0]) { count++; leaf = current.entry; }
    expect(count).toBe(20_000);
    expect(leaf?.id).toBe(restored.leafId);
    expect(restored.context).toEqual({ messages: ["unchanged"] });
  });

  it("preserves multiple roots, child order, entry parents and branch labels", () => {
    const a = node("a"); const b = node("b", "a"); const c = node("c", "a");
    c.label = "Alternative"; a.children = [c, b];
    const roots = [node("orphan", "missing"), a];
    expect(decodeSessionTree(JSON.parse(JSON.stringify(encodeSessionTree(roots))))).toEqual(roots);
    expect(decodeSessionTree(roots)).toBe(roots);
    expect(decodeSessionTree(encodeSessionTree([]))).toEqual([]);
  });

  it("rejects dangling references instead of silently losing history", () => {
    expect(() => decodeSessionTree({ format: "flat-v1", nodes: [], roots: [1] })).toThrow("Invalid session tree reference");
  });
});
