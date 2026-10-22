import type { SessionTreeNode } from "./types";

type MessageEntry = Extract<SessionTreeNode["entry"], { type: "message" }>;
type FlatNode = { entry: SessionTreeNode["entry"]; children: number[]; label?: string };
interface ContextMessageReference { index: number; }
export interface SessionTreeContext { messages?: readonly unknown[]; entryIds?: readonly string[]; }
export type SessionTreeFormat = "flat-v1" | "flat-v2";

/** Both wire shapes have bounded depth even after years of turns. */
export interface FlatSessionTree {
  format: "flat-v1";
  roots: number[];
  nodes: FlatNode[];
}

export interface CompactSessionTree {
  format: "flat-v2";
  roots: number[];
  nodes: Array<FlatNode | {
    entry: Omit<MessageEntry, "message">;
    contextMessage: ContextMessageReference;
    children: number[];
    label?: string;
  }>;
}
export type SessionTreeWire = FlatSessionTree | CompactSessionTree;

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
  for (let i = 0; i < pending.length; i++) nodes[i].children = pending[i].children.map(indexOf);
  return { format: "flat-v1", roots, nodes };
}

/** Identity handles the common SDK case. Copies are compared iteratively once,
 * including every own field, array order and prototype; text alone never dedups. */
function equalMessage(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  const seen = new WeakMap<object, WeakSet<object>>();
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const prototype = Object.getPrototypeOf(a);
    if (prototype !== Object.getPrototypeOf(b)) return false;
    if (!Array.isArray(a) && prototype !== Object.prototype && prototype !== null) return false;
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    const compared = seen.get(a);
    if (compared?.has(b)) continue;
    if (compared) compared.add(b); else seen.set(a, new WeakSet([b]));
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      const av = Object.getOwnPropertyDescriptor(a, key)!;
      const bv = Object.getOwnPropertyDescriptor(b, key)!;
      // Avoid evaluating getters or treating different computed values as equal.
      if (!("value" in av) || !("value" in bv)) return false;
      pending.push([av.value, bv.value]);
    }
  }
  return true;
}

function encodeCompactTree(tree: SessionTreeNode[], context?: SessionTreeContext): CompactSessionTree {
  const flat = encodeSessionTree(tree);
  const messages = context?.messages ?? [];
  const byEntry = new Map((context?.entryIds ?? []).map((id, index) => [id, index]));
  const nodes: CompactSessionTree["nodes"] = flat.nodes.map(node => {
    const index = byEntry.get(node.entry.id);
    if (node.entry.type !== "message" || index === undefined || index >= messages.length) return node;
    const { message, ...entry } = node.entry;
    if (!equalMessage(message, messages[index])) return node;
    return { ...node, entry, contextMessage: { index } };
  });
  return { format: "flat-v2", roots: flat.roots, nodes };
}

export function decodeSessionTree(tree: SessionTreeWire | SessionTreeNode[], context?: SessionTreeContext): SessionTreeNode[] {
  if (Array.isArray(tree)) return tree;
  if (!["flat-v1", "flat-v2"].includes(tree?.format) || !Array.isArray(tree.nodes) || !Array.isArray(tree.roots)) {
    throw new Error("Unsupported session tree format");
  }
  const nodes: SessionTreeNode[] = tree.nodes.map(node => {
    let entry = node.entry;
    if ("contextMessage" in node) {
      const index = node.contextMessage?.index;
      if (tree.format !== "flat-v2" || entry.type !== "message" || "message" in entry
        || !Number.isInteger(index) || index < 0 || !Array.isArray(context?.messages) || index >= context.messages.length
        || !Object.prototype.hasOwnProperty.call(context.messages, index)
        || !Array.isArray(context.entryIds) || context.entryIds[index] !== entry.id) throw new Error("Invalid session context reference");
      entry = { ...entry, message: context.messages[index] as MessageEntry["message"] };
    }
    return { entry: entry as SessionTreeNode["entry"], children: [], ...(node.label !== undefined ? { label: node.label } : {}) };
  });
  const getNode = (index: number): SessionTreeNode => {
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) throw new Error("Invalid session tree reference");
    return nodes[index];
  };
  for (let i = 0; i < nodes.length; i++) {
    if (!Array.isArray(tree.nodes[i].children)) throw new Error("Invalid session tree children");
    nodes[i].children = tree.nodes[i].children.map(getNode);
  }
  return tree.roots.map(getNode);
}

type SessionDataInput = { tree: SessionTreeNode[]; context?: SessionTreeContext };
export function encodeSessionData<T extends SessionDataInput>(data: T, format?: "flat-v1"): Omit<T, "tree"> & { tree: FlatSessionTree };
export function encodeSessionData<T extends SessionDataInput>(data: T, format: "flat-v2"): Omit<T, "tree"> & { tree: CompactSessionTree };
export function encodeSessionData<T extends SessionDataInput>(data: T, format: SessionTreeFormat): Omit<T, "tree"> & { tree: SessionTreeWire };
export function encodeSessionData<T extends SessionDataInput>(data: T, format: SessionTreeFormat = "flat-v1"): Omit<T, "tree"> & { tree: SessionTreeWire } {
  return { ...data, tree: format === "flat-v2" ? encodeCompactTree(data.tree, data.context) : encodeSessionTree(data.tree) };
}

export function decodeSessionData<T extends { tree: SessionTreeWire | SessionTreeNode[]; context?: SessionTreeContext }>(data: T): Omit<T, "tree"> & { tree: SessionTreeNode[] } {
  return { ...data, tree: decodeSessionTree(data.tree, data.context) };
}
