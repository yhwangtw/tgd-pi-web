import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWorkflowExtension } from "../workflow-extension";
import { emptyWorkflow, parseTokenBudget, parseWorkflowCommand, readWorkflow, WORKFLOW_ENTRY, type WorkflowState } from "../workflow-state";
import { TOOL_PRESET_PLAN } from "../tool-selection";

async function harness(initial: WorkflowState = emptyWorkflow()) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, ToolDefinition>();
  const entries = [{ type: "custom", customType: WORKFLOW_ENTRY, data: initial }];
  let active = ["read", "edit", "bash", "mcp_custom"];
  let idle = true;
  let queued = false;
  const ctx = {
    hasUI: true, isIdle: () => idle, hasPendingMessages: () => queued,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => true), select: vi.fn(), input: vi.fn() },
  };
  const send = vi.fn();
  const api = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    appendEntry: (_name: string, data: WorkflowState) => entries.push({ type: "custom", customType: WORKFLOW_ENTRY, data: structuredClone(data) }),
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names]; },
    sendUserMessage: send, sendMessage: send,
  };
  const extension = createWorkflowExtension();
  if (typeof extension === "function") throw new Error("Expected named extension");
  await extension.factory(api as unknown as ExtensionAPI);
  const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  await emit("session_start");
  return {
    api, ctx, entries, emit,
    state: () => entries.at(-1)!.data,
    active: () => active,
    setIdle: (value: boolean) => { idle = value; },
    setQueued: (value: boolean) => { queued = value; },
    command: (name: string, args: string) => commands.get(name)!.handler(args, ctx),
    tool: (name: string, params: unknown) => tools.get(name)!.execute("call", params, undefined, undefined, ctx as never),
    message: (text = "Progress", stopReason = "stop", tokens = 10) => emit("message_end", { message: {
      role: "assistant", content: [{ type: "text", text }], stopReason, usage: { input: tokens, output: 0 },
    } }),
  };
}

describe("persistent Web goals and plans", () => {
  it("starts explicitly, persists the objective, and continues only once at each settled boundary", async () => {
    const h = await harness();
    await h.command("goal", "--tokens 50k Fix the loader");
    expect(h.state().goal).toMatchObject({ objective: "Fix the loader", tokenBudget: 50000, status: "active" });
    expect(h.active()).toContain("mcp_custom");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.emit("agent_start"); await h.message();
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.emit("agent_settled"); await h.emit("agent_settled");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(h.api.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ display: false, customType: "pi-web-goal-continuation" }), expect.objectContaining({ triggerTurn: true }));
    expect(h.state().goal?.tokens).toBe(10);
  });

  it("pause prevents continuation and unrelated later turns do not consume its budget", async () => {
    const h = await harness();
    await h.command("goal", "Fix it"); await h.emit("agent_start");
    await h.command("goal", "pause"); await h.message(); await h.emit("agent_settled");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.emit("agent_start"); await h.message("Unrelated", "stop", 500);
    expect(h.state().goal).toMatchObject({ status: "paused", tokens: 10 });
    await h.command("goal", "resume");
    expect(h.state().goal?.status).toBe("active");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["error", "aborted"])("pauses after %s instead of restarting", async stopReason => {
    const h = await harness();
    await h.command("goal", "Fix it"); await h.emit("agent_start");
    await h.message("", stopReason); await h.emit("agent_settled");
    expect(h.state().goal?.status).toBe("paused");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("stops at the token budget and requires a larger budget before resuming", async () => {
    const h = await harness();
    await h.command("goal", "--tokens 10 Fix it"); await h.emit("agent_start");
    await h.message(); await h.emit("agent_settled");
    expect(h.state().goal?.status).toBe("budget_limited");
    await expect(h.emit("tool_call")).resolves.toMatchObject({ block: true, terminate: true });
    await expect(h.command("goal", "resume")).rejects.toThrow("budget");
    await h.command("goal", "budget 20"); await h.command("goal", "resume");
    expect(h.state().goal).toMatchObject({ status: "active", tokens: 10, tokenBudget: 20 });
  });

  it("does not continue across a dialog, queued input, or a busy runtime", async () => {
    for (const mode of ["dialog", "queued", "busy"]) {
      const h = await harness(); await h.command("goal", "Fix it"); await h.emit("agent_start"); await h.message();
      if (mode === "dialog") await h.emit("ui_prompt_start");
      if (mode === "queued") h.setQueued(true);
      if (mode === "busy") h.setIdle(false);
      await h.emit("agent_settled");
      expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    }
  });

  it("pauses repeated responses but permits sustained progress beyond 25 continuations", async () => {
    const h = await harness(); await h.command("goal", "Fix it");
    for (let i = 0; i < 4; i++) { await h.emit("agent_start"); await h.message("Still working"); await h.emit("agent_settled"); }
    expect(h.state().goal).toMatchObject({ status: "paused", reason: expect.stringContaining("Repeated") });
    await h.command("goal", "resume");
    for (let i = 0; i < 26; i++) { await h.emit("agent_start"); await h.message(`Step ${i}`); await h.emit("agent_settled"); }
    expect(h.state().goal).toMatchObject({ status: "active", automaticRuns: 26 });
  });

  it("honors optional continuation limits, persists them, and allows explicitly disabling them", async () => {
    const h = await harness(); await h.command("goal", "--runs 2 --tokens 100k Fix it");
    for (let i = 0; i < 3; i++) { await h.emit("agent_start"); await h.message(`Step ${i}`); await h.emit("agent_settled"); }
    expect(h.state().goal).toMatchObject({ status: "paused", automaticRuns: 2, automaticRunLimit: 2 });
    expect(readWorkflow(h.state())?.goal?.automaticRunLimit).toBe(2);
    await h.command("goal", "runs 0"); await h.command("goal", "resume");
    for (let i = 0; i < 4; i++) { await h.emit("agent_start"); await h.message(`More ${i}`); await h.emit("agent_settled"); }
    expect(h.state().goal?.status).toBe("active");
    await expect(h.command("goal", "runs -1")).rejects.toThrow("count");
    await expect(h.command("goal", "--runs 1 --runs 2 work")).rejects.toThrow("Use /goal");
  });

  it("tracks independent active steps without switching tools into read-only mode", async () => {
    const h = await harness();
    await h.tool("update_plan", { title: "Parallel", steps: [{ text: "A", status: "in_progress" }, { text: "B", status: "in_progress" }] });
    expect(h.state().plan?.steps.filter(s => s.status === "in_progress")).toHaveLength(2);
    expect(h.active()).toContain("edit");
  });

  it("resumes once after a dialog closes if the last run settled while it was open", async () => {
    const h = await harness(); await h.command("goal", "Fix it"); await h.emit("agent_start"); await h.message();
    await h.emit("ui_prompt_start"); await h.emit("agent_settled");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
    await h.emit("ui_prompt_end"); await h.emit("agent_settled");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("restores branch-local state paused without starting a model", async () => {
    const h = await harness(); await h.command("goal", "Fix it");
    const restored = await harness(h.state());
    expect(restored.state().goal?.status).toBe("paused");
    expect(restored.api.sendUserMessage).not.toHaveBeenCalled();
    restored.entries.splice(0);
    await restored.emit("session_tree");
    expect(restored.ctx.ui.setWidget).toHaveBeenLastCalledWith("Plan", undefined);
    await expect(restored.command("goal", "resume")).rejects.toThrow("new goal");
  });

  it("planning pauses a goal, saves pending steps, and execution restores custom tools", async () => {
    const h = await harness(); await h.command("goal", "Fix it");
    await h.command("plan", "Fix the loader");
    expect(h.state().goal?.status).toBe("paused");
    expect(h.active()).toEqual([...TOOL_PRESET_PLAN]);
    await expect(h.tool("update_plan", { title: "Fix", steps: [{ text: "Change loader", status: "completed" }] })).rejects.toThrow("pending");
    await h.tool("update_plan", { title: "Fix", steps: [{ text: "Change loader", status: "pending" }] });
    expect(h.state().plan?.status).toBe("ready");
    expect(h.active()).not.toContain("edit");
    await h.command("plan", "execute");
    expect(h.state().plan?.status).toBe("executing");
    expect(h.active()).toContain("mcp_custom"); expect(h.active()).toContain("edit");
    await h.tool("update_plan", { title: "Fix", steps: [{ text: "Change loader", status: "completed" }] });
    expect(h.state().plan?.status).toBe("complete");
  });

  it("rejects premature or stale completion and does not continue completed goals", async () => {
    const h = await harness(); await h.command("goal", "Fix it"); await h.emit("agent_start");
    const goalId = h.state().goal!.id;
    await h.tool("update_plan", { title: "Fix", steps: [{ text: "Verify tests", status: "pending" }] });
    await expect(h.tool("goal_status", { goalId, status: "complete", evidence: "Tests passed" })).rejects.toThrow("remaining plan");
    await h.tool("update_plan", { title: "Fix", steps: [{ text: "Verify tests", status: "completed" }] });
    await expect(h.tool("goal_status", { goalId: "stale", status: "complete", evidence: "Tests passed" })).rejects.toThrow("matching");
    await h.tool("goal_status", { goalId, status: "complete", evidence: "All focused tests passed" });
    await h.emit("agent_settled");
    expect(h.api.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("retains the saved plan during refinement even after older conversation text is compacted", async () => {
    const h = await harness(); await h.command("plan", "Fix the loader");
    await h.tool("update_plan", { title: "Loader fix", steps: [{ text: "Change the parser", status: "pending" }] });
    await h.command("plan", "refine Add regression coverage");
    expect(h.state().plan).toMatchObject({ title: "Loader fix", status: "planning", steps: [{ text: "Change the parser", status: "pending" }] });
    await expect(h.emit("before_agent_start", { systemPrompt: "Base" })).resolves.toMatchObject({ systemPrompt: expect.stringContaining("Change the parser") });
  });

  it("rejects malformed persisted state and invalid budgets", () => {
    expect(readWorkflow({ version: 1, goal: {}, plan: null })).toBeNull();
    expect(readWorkflow({ version: 1, goal: null, plan: {} })).toBeNull();
    expect(parseTokenBudget("-1")).toBeNull(); expect(parseTokenBudget("Infinity")).toBeNull();
    expect(parseTokenBudget("1.5k")).toBe(1500);
    expect(parseWorkflowCommand("/goal pause")).toEqual({ command: "goal", args: "pause" });
    expect(parseWorkflowCommand("/goals pause")).toBeNull();
  });
});
