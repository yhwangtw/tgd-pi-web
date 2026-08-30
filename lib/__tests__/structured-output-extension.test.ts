import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  createStructuredOutputExtension,
} from "../structured-output-extension";

async function registeredTool(): Promise<ToolDefinition> {
  let tool: ToolDefinition | undefined;
  const extension = createStructuredOutputExtension();
  if (typeof extension === "function") throw new Error("Expected named extension");
  await extension.factory({ registerTool: (value: ToolDefinition) => { tool = value; } } as never);
  if (!tool) throw new Error("Structured output tool was not registered");
  return tool;
}

describe("structured_output extension", () => {
  it("ships as a terminating embedded Pi tool", async () => {
    const tool = await registeredTool();
    const result = await tool.execute("call-1", {
      headline: "Ready to implement",
      summary: "The plan is scoped and verified.",
      actionItems: ["Update the runtime", "Run focused tests"],
      kind: "info",
      details: "Evidence: `lib/pi-runtime.ts`",
    }, undefined, undefined, {} as never);

    expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({
      headline: "Ready to implement",
      summary: "The plan is scoped and verified.",
      actionItems: ["Update the runtime", "Run focused tests"],
      kind: "info",
      details: "Evidence: `lib/pi-runtime.ts`",
    });
  });

  it("defaults the semantic tone to a verified result", async () => {
    const tool = await registeredTool();
    const result = await tool.execute("call-2", {
      headline: "Done",
      summary: "Verified.",
      actionItems: [],
    }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ kind: "result" });
  });
});
