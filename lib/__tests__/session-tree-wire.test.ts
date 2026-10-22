import { describe, expect, it } from "vitest";
import type { AgentMessage, SessionEntry, SessionTreeNode } from "../types";
import { decodeSessionData, decodeSessionTree, encodeSessionData, encodeSessionTree, type CompactSessionTree, type SessionTreeContext } from "../session-tree-wire";

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


function compactFixture(count: number) {
  const roots: SessionTreeNode[] = [];
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  let previous: SessionTreeNode | undefined;
  for (let i = 0; i < count; i++) {
    const next = node(String(i), i ? String(i - 1) : null);
    const message: AgentMessage = { role: "user", content: `Synthetic turn ${i} ${"x".repeat(256)}`, timestamp: i };
    if (next.entry.type === "message") next.entry.message = message;
    // SDK projections may create equivalent copies instead of sharing identity.
    messages.push({ ...message }); entryIds.push(String(i));
    if (previous) previous.children.push(next); else roots.push(next);
    previous = next;
  }
  return { sessionId: "synthetic", leafId: String(count - 1), tree: roots, context: { messages, entryIds, model: null, thinkingLevel: "off" } };
}

describe("compact session tree transport", () => {
  it.each([10_000, 20_000])("round trips every field of %s messages with one wire copy of context history", count => {
    const original = compactFixture(count);
    const v1 = JSON.stringify(encodeSessionData(original));
    const compact = encodeSessionData(original, "flat-v2");
    const v2 = JSON.stringify(compact);
    expect(compact.tree.nodes.every(node => "contextMessage" in node && !("message" in node.entry))).toBe(true);
    expect(Buffer.byteLength(v2)).toBeLessThan(Buffer.byteLength(v1) * .7);
    const restored = decodeSessionData(JSON.parse(v2));
    expect(restored.context).toEqual(original.context);
    expect(restored.sessionId).toBe(original.sessionId);
    expect(restored.leafId).toBe(original.leafId);
    // Compare bounded-depth representations so the assertion does not overflow
    // while examining a 20,000-level native tree.
    expect(encodeSessionTree(restored.tree)).toEqual(encodeSessionTree(original.tree));
    let length = 0;
    for (let current: SessionTreeNode | undefined = restored.tree[0]; current; current = current.children[0]) length++;
    expect(length).toBe(count);
  });

  it("preserves branch order, labels, compaction and custom entries exactly", () => {
    const a = node("a"); const b = node("b", "a"); const c = node("c", "a");
    c.label = "Alternative"; a.children = [c, b];
    const compaction: SessionTreeNode = { entry: { type: "compaction", id: "compact", parentId: "b", timestamp: "now", summary: "Kept summary", firstKeptEntryId: "b", tokensBefore: 900, details: { retained: true }, fromHook: true }, children: [] };
    const custom: SessionTreeNode = { entry: { type: "custom_message", id: "custom", parentId: "compact", timestamp: "now", customType: "memory", content: "Context annotation", display: false, details: { hidden: true } }, children: [] };
    b.children.push(compaction); compaction.children.push(custom);
    const roots = [node("orphan", "missing"), a];
    const context = { messages: [a.entry.type === "message" ? a.entry.message : null, { role: "user", content: "same text, different entry" }], entryIds: ["a", "another"] };
    const wire = encodeSessionData({ tree: roots, context, extra: { value: "preserved" } }, "flat-v2");
    expect(wire.tree.nodes.filter(node => "contextMessage" in node)).toHaveLength(1);
    expect(wire.tree.nodes.find(node => node.entry.id === "compact")?.entry).toBe(compaction.entry);
    expect(wire.tree.nodes.find(node => node.entry.id === "custom")?.entry).toBe(custom.entry);
    expect(decodeSessionData(JSON.parse(JSON.stringify(wire)))).toEqual({ tree: roots, context, extra: { value: "preserved" } });
  });

  it("deduplicates structurally equal objects regardless of property insertion order", () => {
    const entry = node("one");
    const context = { entryIds: ["one"], messages: [{ timestamp: 1, content: "one", role: "user" }] };
    const wire = encodeSessionData({ tree: [entry], context }, "flat-v2");
    expect(wire.tree.nodes[0]).toHaveProperty("contextMessage.index", 0);
    expect(decodeSessionData(wire).tree[0].entry).toEqual(entry.entry);
  });

  it("keeps differing usage, provider, tools, arrays and normalization fields inline", () => {
    const message: AgentMessage = { role: "assistant", model: "test", provider: "provider", timestamp: 1,
      content: [{ type: "text", text: "Same visible answer" }, { type: "toolCall", toolCallId: "call", toolName: "read", input: { path: "/fixture", lines: [1, 2] } }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const variants: unknown[] = [
      { ...message, provider: "another" },
      { ...message, usage: { ...message.usage, output: 3 } },
      { ...message, stopReason: "stop" },
      { ...message, content: [...message.content].reverse() },
      { ...message, content: [message.content[0], { ...message.content[1], input: { path: "/fixture", lines: [2, 1] } }] },
      { ...message, normalized: true },
      { ...message, optional: undefined },
      Object.assign(Object.create(null), message),
      { ...message, content: Object.assign({}, message.content) },
    ];
    for (const candidate of variants) {
      const current = node("one"); if (current.entry.type === "message") current.entry.message = message;
      const wire = encodeSessionData({ tree: [current], context: { messages: [candidate], entryIds: ["one"] } }, "flat-v2");
      expect(wire.tree.nodes[0]).not.toHaveProperty("contextMessage");
      expect(wire.tree.nodes[0].entry).toBe(current.entry);
    }
    const otherId = encodeSessionData({ tree: [node("one")], context: { messages: [{ role: "user", content: "one", timestamp: 1 }], entryIds: ["two"] } }, "flat-v2");
    expect(otherId.tree.nodes[0]).not.toHaveProperty("contextMessage");
  });

  it("does not execute getters while comparing copied messages", () => {
    let reads = 0;
    const candidate = { role: "user", timestamp: 1, get content() { reads++; return "one"; } };
    const wire = encodeSessionData({ tree: [node("one")], context: { messages: [candidate], entryIds: ["one"] } }, "flat-v2");
    expect(reads).toBe(0);
    expect(wire.tree.nodes[0]).not.toHaveProperty("contextMessage");
  });

  it("bounds comparison work for repeated object references and cyclic non-JSON inputs", () => {
    const original = { role: "user", content: "one", timestamp: 1 };
    const copy = { ...original };
    const a = { first: original, second: original, cycle: undefined as unknown };
    const b = { first: copy, second: copy, cycle: undefined as unknown };
    a.cycle = a; b.cycle = b;
    const current = node("one");
    if (current.entry.type === "message") Object.assign(current.entry.message, { metadata: a });
    const wire = encodeSessionData({ tree: [current], context: { messages: [{ ...original, metadata: b }], entryIds: ["one"] } }, "flat-v2");
    // Such inputs cannot be JSON-serialized, but encoding must still terminate.
    expect(wire.tree.nodes[0]).toHaveProperty("contextMessage.index", 0);
  });

  it("validates context indexes and entry identities before reconstructing a message", () => {
    const wire = encodeSessionData({ tree: [node("one")], context: { messages: [{ role: "user", content: "one", timestamp: 1 }], entryIds: ["one"] } }, "flat-v2");
    const invalid = (context: SessionTreeContext | undefined, mutate?: (tree: CompactSessionTree) => void) => {
      const tree = structuredClone(wire.tree); mutate?.(tree);
      expect(() => decodeSessionTree(tree, context)).toThrow("Invalid session context reference");
    };
    invalid(undefined);
    invalid({ messages: wire.context.messages, entryIds: ["another"] });
    invalid({ messages: [], entryIds: ["one"] });
    invalid({ messages: new Array(1), entryIds: ["one"] });
    for (const index of [-1, 0.5, 1, Number.NaN, Number.POSITIVE_INFINITY]) invalid(wire.context, tree => {
      const current = tree.nodes[0]; if ("contextMessage" in current) current.contextMessage.index = index;
    });
    invalid(wire.context, tree => Object.assign(tree.nodes[0].entry, { message: wire.context.messages[0] }));
    expect(() => decodeSessionTree({ ...wire.tree, format: "flat-v1" } as never, wire.context)).toThrow("Invalid session context reference");
  });

  it("can read native/v1 data and v2 without a context or any deduplication matches", () => {
    const roots = [node("one")];
    expect(decodeSessionData({ tree: roots }).tree).toBe(roots);
    expect(decodeSessionData(encodeSessionData({ tree: roots })).tree).toEqual(roots);
    const wire = encodeSessionData({ tree: roots }, "flat-v2");
    expect(wire.tree.nodes[0]).not.toHaveProperty("contextMessage");
    expect(decodeSessionData(JSON.parse(JSON.stringify(wire))).tree).toEqual(roots);
  });
});
