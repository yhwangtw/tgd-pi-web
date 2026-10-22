import type { SessionTreeNode } from "./types";

/** The wire shape has bounded depth even when a conversation has years of turns. */
export interface FlatSessionTree {
  format: "flat-v1";
  roots: number[];
  nodes: { entry: SessionTreeNode["entry"]; children: number[]; label?: string }[];
}

export function encodeSessionTree(tree: SessionTreeNode[]): FlatSessionTree {
  const nodes: FlatSessionTree["nodes"] = [];
  const indices = new Map<SessionTreeNode, number>();
  const pending: SessionTreeNode[] = [];
  const indexOf = (node: SessionTreeNode): number => {
    const existing = indices.get(node);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    indices.set(node, index);
    nodes.push({ entry: node.entry, children: [], ...(node.label !== undefined ? { label: node.label } : {}) });
    pending.push(node);
    return index;
  };
  const roots = tree.map(indexOf);
  for (let i = 0; i < pending.length; i++) {
    nodes[i].children = pending[i].children.map(indexOf);
  }
  return { format: "flat-v1", roots, nodes };
}

export function decodeSessionTree(tree: FlatSessionTree | SessionTreeNode[]): SessionTreeNode[] {
  // Previously loaded clients/fixtures and old event snapshots remain readable.
  if (Array.isArray(tree)) return tree;
  if (tree?.format !== "flat-v1" || !Array.isArray(tree.nodes) || !Array.isArray(tree.roots)) {
    throw new Error("Unsupported session tree format");
  }
  const nodes: SessionTreeNode[] = tree.nodes.map(node => ({ entry: node.entry, children: [], ...(node.label !== undefined ? { label: node.label } : {}) }));
  const getNode = (index: number): SessionTreeNode => {
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) throw new Error("Invalid session tree reference");
    return nodes[index];
  };
  for (let i = 0; i < nodes.length; i++) nodes[i].children = tree.nodes[i].children.map(getNode);
  return tree.roots.map(getNode);
}

export function encodeSessionData<T extends { tree: SessionTreeNode[] }>(data: T): Omit<T, "tree"> & { tree: FlatSessionTree } {
  return { ...data, tree: encodeSessionTree(data.tree) };
}

export function decodeSessionData<T extends { tree: FlatSessionTree | SessionTreeNode[] }>(data: T): Omit<T, "tree"> & { tree: SessionTreeNode[] } {
  return { ...data, tree: decodeSessionTree(data.tree) };
}
