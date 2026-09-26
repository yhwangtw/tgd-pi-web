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
  const extension = createSubagentExtension({ readLimits: () => ({ maxTurns: 0, maxCostUsd: 0, timeoutMs: 0 }), ...options });
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ getActiveTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp_custom", "subagent"], registerTool: (value: ToolDefinition) => { tool = value; } } as never);
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

  it("gives every built-in read-only role inspection tools without shell access", () => {
    for (const name of ["scout", "planner", "reviewer"]) {
      expect(BUILTIN_SUBAGENTS.find(agent => agent.name === name)?.tools)
        .toEqual(["read", "grep", "find", "ls"]);
    }
  });

  it("starts independent workers and readers before any finish, preserving request order", async () => {
    const release = new Map<string, () => void>();
    const executor = vi.fn(async request => {
      await new Promise<void>(resolve => release.set(request.task, resolve));
      return completedRun(request.agent.name, request.task);
    });
    const tool = await registeredTool({ executor });
    const pending = executeTool(tool, { tasks: [
      { agent: "worker", task: "Edit component A" },
      { agent: "worker", task: "Edit independent component B" },
      { agent: "scout", task: "Inspect unrelated module C" },
    ] });
    expect(executor).toHaveBeenCalledTimes(3);
    release.get("Inspect unrelated module C")!();
    release.get("Edit independent component B")!();
    release.get("Edit component A")!();
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("3/3 subagents completed");
    expect(result.details.runs.map(run => run.agent)).toEqual(["worker", "worker", "scout"]);
    expect(result.content[0].text!.indexOf("Edit component A")).toBeLessThan(result.content[0].text!.indexOf("Edit independent component B"));
  });

  it("does not start the remaining writes after the parent is cancelled", async () => {
    const controller = new AbortController();
    const executor = vi.fn(async request => { controller.abort(); return completedRun(request.agent.name, "done"); });
    const tool = await registeredTool({ executor });
    const result = await tool.execute("call", { tasks: [{ agent: "worker", task: "first" }, { agent: "worker", task: "second" }] }, controller.signal, undefined, context() as never) as unknown as TestToolResult;
    expect(executor).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("1/2 subagents completed (remaining tasks cancelled)");
  });

  it("passes chain output into the next task and stops a failed chain", async () => {
    const executor = vi.fn(async request => request.agent.name === "scout" ? completedRun("scout", "loader.ts") : {
      run: { ...completedRun("worker", "").run, status: "failed" as const, error: "Verification failed" },
    });
    const tool = await registeredTool({ executor });
    const result = await executeTool(tool, { chain: [{ agent: "scout", task: "Find it" }, { agent: "worker", task: "Fix {previous}" }, { agent: "reviewer", task: "Review {previous}" }] });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[1][0].task).toBe("Fix loader.ts");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Chain stopped at worker");
  });

  it("inherits only active parent tools and cannot raise configured budgets", async () => {
    const executor = vi.fn(async request => completedRun(request.agent.name, "done"));
    const tool = await registeredTool({ executor, readLimits: () => ({ maxTurns: 50, maxCostUsd: 4, timeoutMs: 60000 }) });
    await executeTool(tool, { tasks: [
      { agent: "worker", task: "A", limits: { maxCostUsd: 99, maxTurns: 0 } },
      { agent: "worker", task: "B", tools: ["mcp_custom", "not_enabled", "subagent"], limits: { maxTurns: 10 } },
    ] });
    const [first, second] = executor.mock.calls.map(([request]) => request);
    expect(first.agent.tools).toContain("mcp_custom");
    expect(first.agent.tools).not.toContain("subagent");
    expect(second.agent.tools).toEqual(["mcp_custom"]);
    expect(first.limits).toEqual({ maxTurns: 50, maxCostUsd: 4, timeoutMs: 60000 });
    expect(second.limits.maxTurns).toBe(10);
    expect(first.budgetGroup).toEqual(second.budgetGroup);
    expect(first.budgetGroup.maxCostUsd).toBe(4);
  });

  it("applies request-wide allocations to the shared cap and every task", async () => {
    const executor = vi.fn(async request => completedRun(request.agent.name, "done"));
    const tool = await registeredTool({ executor, readLimits: () => ({ maxCostUsd: 5 }) });
    await executeTool(tool, { tools: ["read", "mcp_custom"], limits: { maxCostUsd: 2 }, tasks: [
      { agent: "worker", task: "A", limits: { maxCostUsd: 10 } },
      { agent: "worker", task: "B", tools: ["read", "write"], limits: { maxCostUsd: 1 } },
    ] });
    const [first, second] = executor.mock.calls.map(([request]) => request);
    expect(first.budgetGroup.maxCostUsd).toBe(2);
    expect(first.limits.maxCostUsd).toBe(2);
    expect(second.limits.maxCostUsd).toBe(1);
    expect(first.agent.tools).toEqual(["read", "mcp_custom"]);
    expect(second.agent.tools).toEqual(["read"]);
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
