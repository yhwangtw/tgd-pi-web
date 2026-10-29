import { describe, expect, it } from "vitest";
import { activeToolDetails, activeToolPreview, getToolPreview } from "../tool-preview";
import type { AgentMessage, ToolCallContent } from "../types";

const call: ToolCallContent = { type: "toolCall", toolCallId: "read-current", toolName: "read", input: { path: "src/current.ts" } };
const message: AgentMessage = { role: "assistant", content: [call], timestamp: 1 } as AgentMessage;
const phase = { kind: "running_tools", tools: [{ id: "read-current", name: "read" }] } as const;

describe("live tool previews", () => {
  it("uses the exact active call and accepts a still-streaming argument", () => {
    const active = { ...phase, tools: [...phase.tools] };
    expect(activeToolPreview(active, [message])).toBe("src/current.ts");
    expect(activeToolPreview(active, [], message)).toBe("src/current.ts");
  });
  it("never guesses from an unrelated past or similarly named tool", () => {
    expect(activeToolPreview({ kind: "running_tools", tools: [{ id: "new-call", name: "read" }] }, [message])).toBe("");
    expect(activeToolPreview({ kind: "waiting_model" }, [message])).toBe("");
    expect(activeToolPreview({ kind: "running_tools", tools: [{ id: call.toolCallId, name: "bash" }] }, [message])).toBe("");
  });
  it("bounds a command summary and handles empty arguments", () => {
    expect(getToolPreview({ ...call, input: { command: "x".repeat(300) } })).toHaveLength(120);
    expect(getToolPreview({ ...call, input: {} })).toBe("");
  });
  it("keeps full targets for every exact active tool, independent of history order", () => {
    const longPath = "src/" + "a".repeat(240) + ".ts";
    const second = { ...call, toolCallId: "second", input: { path: longPath } };
    const tools = activeToolDetails({ kind: "running_tools", tools: [{ id: "second", name: "read" }, { id: "missing", name: "read" }] }, [message], { role: "assistant", content: [second] });
    expect(tools[0]).toMatchObject({ id: "second", target: longPath, canReveal: true });
    expect(tools[0].preview.length).toBe(120);
    expect(tools[1]).toMatchObject({ id: "missing", target: "", canReveal: false });
  });

});
