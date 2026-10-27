import { describe, expect, it } from "vitest";
import { getAssistantFailure, getAssistantOutputIssue } from "../assistant-outcome";
import { assistantFailure } from "../session-error-summary";
import { getSessionSearchMetadata } from "../session-search";

describe("assistant output outcomes", () => {
  it.each([[], [{ type: "thinking", thinking: "reasoning only" }], [{ type: "text", text: "partial" }]].map(content => ({ content })))("preserves a length stop with any content: %j", ({ content }) => {
    const message = { role: "assistant", stopReason: "length", content };
    expect(getAssistantOutputIssue(message)).toBe("output_limit");
    expect(getAssistantFailure(message)).toBe("Output token limit reached");
    expect(assistantFailure(message)?.message).toBe("Output token limit reached");
    expect(getSessionSearchMetadata([{ type: "message", message }]).status).toBe("failed");
  });
  it.each([[], [{ type: "text", text: "  " }], [{ type: "thinking", thinking: "only thinking" }]].map(content => ({ content })))("reports a finished empty answer without assuming why: %j", ({ content }) => {
    expect(getAssistantOutputIssue({ role: "assistant", stopReason: "stop", content })).toBe("empty_output");
  });
  it.each([null, undefined, {}, { role: "assistant", stopReason: "stop" }, { role: "assistant", content: [] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "image" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "toolCall" }] },
    { role: "assistant", stopReason: "toolUse", content: [] },
    { role: "assistant", stopReason: "aborted", content: [] },
    { role: "user", stopReason: "length", content: [] }])("does not invent an output failure for %j", message => {
    expect(getAssistantOutputIssue(message)).toBeNull();
  });
});
