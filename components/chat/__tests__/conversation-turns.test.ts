import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage } from "@/lib/types";
import { buildConversationLayout } from "../conversation-turns";

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", provider: "test", model: "test", content, ...extra };
}

describe("buildConversationLayout", () => {
  it("collapses a multi-message agent loop into one work-log owner plus the final answer", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Fix it", timestamp: 1_000 },
      assistant([
        { type: "thinking", thinking: "inspect" },
        { type: "toolCall", toolCallId: "a", toolName: "read", input: { path: "a.ts" } },
      ], { timestamp: 2_000, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } }),
      { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "ok" }], timestamp: 3_000 },
      assistant([
        { type: "thinking", thinking: "edit" },
        { type: "toolCall", toolCallId: "b", toolName: "edit", input: { path: "a.ts", oldText: "a", newText: "b" } },
      ], { timestamp: 4_000 }),
      { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "ok" }], timestamp: 5_000 },
      assistant([{ type: "text", text: "Done" }], { timestamp: 6_000, usage: { input: 20, output: 4, cacheRead: 5, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } } }),
    ];

    const layout = buildConversationLayout(messages);
    expect(layout.displayIndices).toEqual([0, 5]);
    expect(layout.activityByOwner.get(5)).toHaveLength(2);
    expect(layout.activityAssistantIndices).toEqual(new Set([1, 3, 5]));
    expect(layout.finalAssistantIndices).toEqual(new Set([5]));
    expect(layout.usageByFinalAssistant.get(5)).toMatchObject({ input: 30, output: 6, cacheRead: 5, cost: { total: 0.03 } });
  });

  it.each(["length", "stop"])("keeps a final %s outcome visible even with no text or activity", stopReason => {
    const layout = buildConversationLayout([{ role: "user", content: "Answer" }, assistant([], { stopReason })]);
    expect(layout.displayIndices).toEqual([0, 1]);
    expect(layout.finalAssistantIndices.has(1)).toBe(true);
  });

  it("keeps ordinary answers and errored outcomes visible", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hi" },
      assistant([{ type: "text", text: "Hello" }]),
      { role: "user", content: "Again" },
      assistant([], { stopReason: "error", errorMessage: "boom" }),
    ];
    const layout = buildConversationLayout(messages);
    expect(layout.displayIndices).toEqual([0, 1, 2, 3]);
    expect(layout.activityByOwner.size).toBe(0);
  });
});
