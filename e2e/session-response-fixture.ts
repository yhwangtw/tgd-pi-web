import type { CompactSessionTree } from "../lib/session-tree-wire";

// Compact tree nodes reference context messages by both position and entry ID.
// Replace these together so intercepted session reads remain valid flat-v2 data.
export function withFixtureMessages<T extends { context?: object }>(
  data: T,
  messages: readonly { timestamp?: unknown }[],
  entryIds: readonly string[],
) {
  if (messages.length !== entryIds.length) throw new Error("Fixture messages and entry IDs must match");
  const tree: CompactSessionTree = {
    format: "flat-v2",
    roots: messages.length ? [0] : [],
    nodes: messages.map((message, index) => ({
      entry: {
        type: "message", id: entryIds[index], parentId: index === 0 ? null : entryIds[index - 1],
        timestamp: new Date(typeof message.timestamp === "number" ? message.timestamp : 0).toISOString(),
      },
      contextMessage: { index },
      children: index + 1 < messages.length ? [index + 1] : [],
    })),
  };
  return { ...data, context: { ...data.context, messages, entryIds }, tree, leafId: entryIds.at(-1) ?? null };
}
