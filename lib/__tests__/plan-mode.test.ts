import { describe, expect, it, vi } from "vitest";
import type {
  BeforeAgentStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  PLAN_MODE_PROMPT,
  createPlanModeExtension,
  isPlanReadOnlyCommand,
  isPlanToolSelection,
} from "../plan-mode";
import { TOOL_PRESET_PLAN } from "../tool-selection";

function tool(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

describe("Plan Mode", () => {
  it("recognizes its complete boxed tool preset", () => {
    expect(isPlanToolSelection([...TOOL_PRESET_PLAN].reverse())).toBe(true);
    expect(isPlanToolSelection(["read", "bash"])).toBe(false);
  });

  it.each([
    "rg -n plan-mode lib | head -20",
    "git status --short",
    "find components -maxdepth 2 -type f",
    "npm view react version",
    "curl -I https://example.com",
  ])("allows read-only inspection command: %s", (command) => {
    expect(isPlanReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    "rm -rf build",
    "git checkout -- app/page.tsx",
    "ls; touch changed.txt",
    "ls && npm test",
    "cat package.json > copy.json",
    "curl -X POST https://example.com/run",
    "find . -name '*.tmp' -delete",
  ])("blocks mutating or compound command: %s", (command) => {
    expect(isPlanReadOnlyCommand(command)).toBe(false);
  });

  it("injects planning rules and blocks writes only while the preset is active", async () => {
    let activeTools: string[] = [...TOOL_PRESET_PLAN];
    const handlers = new Map<string, (event: never) => unknown>();
    const extension = createPlanModeExtension();
    if (typeof extension === "function") throw new Error("Expected named extension");
    extension.factory({
      getActiveTools: () => activeTools,
      on: vi.fn((name, handler) => handlers.set(name, handler as never)),
    } as never);

    const before = handlers.get("before_agent_start")!;
    const event = {
      type: "before_agent_start",
      prompt: "Plan a fix",
      systemPrompt: "Base system prompt",
      systemPromptOptions: {},
    } as BeforeAgentStartEvent;
    await expect(before(event as never)).resolves.toMatchObject({
      systemPrompt: expect.stringContaining(PLAN_MODE_PROMPT),
    });

    const onToolCall = handlers.get("tool_call")!;
    await expect(onToolCall(tool("write", { path: "file.ts", content: "x" }) as never))
      .resolves.toMatchObject({ block: true });
    await expect(onToolCall(tool("bash", { command: "git status --short" }) as never))
      .resolves.toBeUndefined();

    activeTools = ["read", "bash", "edit", "write", "ask_user", "structured_output"];
    await expect(before(event as never)).resolves.toBeUndefined();
    await expect(onToolCall(tool("write", { path: "file.ts", content: "x" }) as never))
      .resolves.toBeUndefined();
  });
});
