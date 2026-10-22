import { expect, it, vi } from "vitest";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";
import { buildConversationLayout } from "../conversation-turns";
import { buildTranscriptSearchIndex, findTranscriptMatches } from "../transcript-search";

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", model: "test", provider: "test", content });
it("indexes committed tool arguments once while repeated queries preserve all search scopes", () => {
  const args = { command: "needle command" };
  const result: ToolResultMessage = { role: "toolResult", toolCallId: "call", isError: true, content: [{ type: "text", text: "needle result" }] };
  const messages: AgentMessage[] = [
    { role: "user", content: "needle question" },
    assistant([{ type: "toolCall", toolCallId: "call", toolName: "bash", input: args }]),
    result,
    assistant([{ type: "text", text: "needle answer" }]),
    { role: "user", content: "Another question" },
    assistant([{ type: "text", text: "All clear" }]),
  ];
  const stringify = vi.spyOn(JSON, "stringify");
  const rows = buildTranscriptSearchIndex(messages, buildConversationLayout(messages), new Map([["call", result]]));
  const expected = rows.findIndex(row => row.text.includes("needle answer"));
  expect(findTranscriptMatches(rows, "NEEDLE", "all")).toEqual([0, expected]);
  expect(findTranscriptMatches(rows, "needle", "user")).toEqual([0]);
  expect(findTranscriptMatches(rows, "needle", "assistant")).toEqual([expected]);
  expect(findTranscriptMatches(rows, "command", "tools")).toEqual([expected]);
  expect(findTranscriptMatches(rows, "result", "errors")).toEqual([expected]);
  for (let i = 0; i < 100; i++) findTranscriptMatches(rows, `query ${i}`, "tools");
  expect(stringify.mock.calls.filter(([value]) => value === args)).toHaveLength(1);
  stringify.mockRestore();
});

it("updates a replacement message, keeps large history searchable and accepts empty queries", () => {
  const messages: AgentMessage[] = Array.from({ length: 10_000 }, (_, i) => ({ role: "user", content: `Question ${i}` }));
  const build = () => buildTranscriptSearchIndex(messages, buildConversationLayout(messages), new Map());
  expect(findTranscriptMatches(build(), "Question 9999", "all")).toEqual([9999]);
  messages[0] = { role: "user", content: "Replaced text" };
  const rows = build();
  expect(findTranscriptMatches(rows, "replaced", "user")).toEqual([0]);
  expect(findTranscriptMatches(rows, "  ", "all")).toEqual([]);
});
