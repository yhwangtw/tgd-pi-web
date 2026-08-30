import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRun, AgentRunCompletion } from "../agent-run-types";
import {
  BUILTIN_SUBAGENTS,
  composeSubagentPrompt,
  createSubagentExtension,
  discoverSubagents,
  type SubagentDefinition,
} from "../subagent-extension";

function completedRun(name: string, output: string): AgentRunCompletion {
  const run: AgentRun = {
    id: `${name}-run`,
    name,
    cwd: "/workspace",
    prompt: `Run ${name}`,
    trigger: "subagent",
    status: "completed",
    createdAt: "2026-08-30T00:00:00.000Z",
    toolNames: ["read"],
    report: {
      summary: output,
      changedFiles: [],
      tests: [],
      tools: ["read"],
      usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
      durationMs: 100,
    },
  };
  return {
    run,
    messages: [{
      role: "assistant",
      provider: "test",
      model: "model",
      content: [{ type: "text", text: output }],
    }],
  };
}

async function registeredTool(options: Parameters<typeof createSubagentExtension>[0] = {}) {
  let tool: ToolDefinition | undefined;
  const extension = createSubagentExtension(options);
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ registerTool: (value: ToolDefinition) => { tool = value; } } as never);
  if (!tool) throw new Error("Subagent tool was not registered");
  return tool;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/workspace",
    model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    thinkingLevel: "medium",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { confirm: vi.fn(async () => true) },
    ...overrides,
  };
}

interface TestToolResult {
  content: Array<{ type: string; text?: string }>;
  details: { runs: Array<{ agent: string; status: string }> };
  isError?: boolean;
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  ctx = context(),
  onUpdate?: (value: unknown) => void,
): Promise<TestToolResult> {
  return await tool.execute("test-call", params, undefined, onUpdate as never, ctx as never) as unknown as TestToolResult;
}

describe("built-in Web subagents", () => {
  it("ships a safe default team without a user-level installation", () => {
    expect(BUILTIN_SUBAGENTS.map((agent) => agent.name)).toEqual([
      "scout",
      "planner",
      "worker",
      "reviewer",
    ]);
    expect(discoverSubagents("/workspace", "builtin").map((agent) => agent.name))
      .toEqual(["scout", "planner", "worker", "reviewer"]);
    expect(BUILTIN_SUBAGENTS.find((agent) => agent.name === "scout")?.tools)
      .not.toContain("write");
    expect(BUILTIN_SUBAGENTS.find((agent) => agent.name === "worker")?.tools)
      .toContain("edit");
  });

  it("wraps the delegated role and task without replacing project context", () => {
    const prompt = composeSubagentPrompt(BUILTIN_SUBAGENTS[0], "Trace the session loader");
    expect(prompt).toContain('<delegated_role name="scout" source="builtin">');
    expect(prompt).toContain("Trace the session loader");
    expect(prompt).toContain("Complete only this task");
  });

  it("registers one tool and delegates through the embedded runner", async () => {
    const executor = vi.fn(async (request) => completedRun(request.agent.name, "Found the loader."));
    const tool = await registeredTool({ executor });
    const updates = vi.fn();

    const result = await executeTool(
      tool,
      { agent: "scout", task: "Find the loader" },
      context(),
      updates,
    );

    expect(tool.name).toBe("subagent");
    expect(result.content[0].text).toBe("Found the loader.");
    expect(result.details.runs[0]).toMatchObject({ agent: "scout", status: "completed" });
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ name: "scout" }),
      cwd: "/workspace",
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinkingLevel: "medium",
    }), expect.objectContaining({ signal: undefined }));
  });

  it("runs parallel requests and keeps result order stable", async () => {
    const executor = vi.fn(async (request) => completedRun(request.agent.name, `${request.agent.name} done`));
    const tool = await registeredTool({ executor });
    const result = await executeTool(tool, {
      tasks: [
        { agent: "scout", task: "Map it" },
        { agent: "reviewer", task: "Review it" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("2/2 subagents completed");
    expect(result.details.runs.map((run: { agent: string }) => run.agent)).toEqual(["scout", "reviewer"]);
  });

  it("requires confirmation before an untrusted project agent runs", async () => {
    const projectAgent: SubagentDefinition = {
      name: "repo-agent",
      description: "Repository controlled",
      tools: ["read"],
      systemPrompt: "Inspect the repository.",
      source: "project",
      filePath: "/workspace/.pi/agents/repo-agent.md",
    };
    const executor = vi.fn(async () => completedRun("repo-agent", "done"));
    const confirm = vi.fn(async () => false);
    const tool = await registeredTool({ executor, discover: () => [...BUILTIN_SUBAGENTS, projectAgent] });

    const result = await executeTool(tool, {
      agent: "repo-agent",
      task: "Inspect",
      agentScope: "project",
    }, context({ isProjectTrusted: () => false, ui: { confirm } }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(executor).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/cancelled/i);
  });
});
