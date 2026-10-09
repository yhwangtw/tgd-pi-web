import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMcpExtension } from "./mcp";

/** Adapt the canonical MCP registration, including its live configuration checks,
 * schemas, connection ownership and result conversion. A remote tool's side
 * effects are unknown, so recovery must never automatically invoke it again. */
export async function createDurableMcpExtension(cwd: string): Promise<Extension> {
  const tools: ToolDefinition[] = [];
  const extension = createMcpExtension(cwd);
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as never);
  return defineExtension({
    name: "pi-web-mcp",
    tools: tools.map(tool => defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      replay: "unsafe",
      execute: async (args, api, context) => {
        // Built-in MCP tools consume only arguments and the cancellation signal.
        const result = await tool.execute(api.callId, args, context.abortSignal, undefined, {} as never);
        return {
          content: result.content,
          // The legacy MCP adapter can include an undefined structuredContent;
          // Durable documents/results accept JSON values only.
          ...(result.details === undefined ? {} : { details: JSON.parse(JSON.stringify(result.details)) }),
        };
      },
    })),
  });
}
