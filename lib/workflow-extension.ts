import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isPlanToolSelection } from "./plan-mode";
import { TOOL_PRESET_DEFAULT, TOOL_PRESET_PLAN } from "./tool-selection";
import { emptyWorkflow, GOAL_AUTOMATIC_RUN_LIMIT, parseTokenBudget, readWorkflow, WORKFLOW_ENTRY } from "./workflow-state";

/** Uses only the SDK's RPC-safe UI, session entries, and settled lifecycle. */
export function createWorkflowExtension(): InlineExtension {
  return { name: "pi-web-workflow", factory(pi: ExtensionAPI) {
    let state = emptyWorkflow();
    let generation = 0;
    let settledGeneration = -1;
    let pendingContinuation = false;
    let pendingDialogs = 0;
    let lastOutput = "";
    let repeatedRuns = 0;
    let runHadTools = false;
    let runOutput = "";
    let commandBusy = false;
    let runGoalId: string | undefined;
    let runSettled = false;

    const render = (ctx: ExtensionContext) => {
      const { goal, plan } = state;
      ctx.ui.setStatus("Goal", goal ? `${goal.status} · ${goal.tokens.toLocaleString()}${goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} tokens` : undefined);
      ctx.ui.setWidget("Goal", goal ? [goal.objective, ...(goal.reason ? [goal.reason] : []), "/goal · /goal pause · /goal resume"] : undefined);
      ctx.ui.setStatus("Plan", plan ? `${plan.status} · ${plan.steps.filter(s => s.status === "completed").length}/${plan.steps.length}` : undefined);
      ctx.ui.setWidget("Plan", plan ? [plan.title, ...plan.steps.map((s, i) => `${s.status === "completed" ? "✓" : s.status === "in_progress" ? "→" : "○"} ${i + 1}. ${s.text}`), "/plan · /plan execute · /plan cancel"] : undefined);
    };
    const save = (ctx: ExtensionContext) => {
      pi.appendEntry(WORKFLOW_ENTRY, structuredClone(state));
      render(ctx);
    };
    const pause = (ctx: ExtensionContext, reason: string) => {
      if (state.goal?.status !== "active") return;
      state.goal.status = "paused";
      state.goal.reason = reason;
      save(ctx);
    };
    const load = (_event: unknown, ctx: ExtensionContext) => {
      state = emptyWorkflow();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === WORKFLOW_ENTRY) {
          const restored = readWorkflow(entry.data);
          if (restored) state = restored;
        }
      }
      generation++;
      settledGeneration = generation;
      pendingContinuation = false;
      pendingDialogs = 0;
      lastOutput = "";
      repeatedRuns = 0;
      runGoalId = undefined;
      runSettled = false;
      if (state.plan?.status === "planning" || state.plan?.status === "ready") pi.setActiveTools([...TOOL_PRESET_PLAN]);
      // Reopening a runtime/branch must not start billable work by itself.
      pause(ctx, "Session reopened. Use /goal resume to continue.");
      render(ctx);
    };
    pi.on("session_start", load);
    pi.on("session_tree", load);
    pi.on("session_shutdown", () => { pendingContinuation = false; generation++; });

    const ensureGoalTools = () => pi.setActiveTools([...new Set([...pi.getActiveTools(), "goal_status", "update_plan"])]);
    const send = (text: string, automatic = false) => {
      pendingContinuation = true;
      if (automatic) pi.sendMessage({ customType: "pi-web-goal-continuation", content: text, display: false }, { triggerTurn: true, deliverAs: "followUp" });
      else pi.sendUserMessage(text, { deliverAs: "followUp" });
    };
    const goalCommand = async (raw: string, ctx: ExtensionContext) => {
      let args = raw.trim();
      if (!args) {
        if (!ctx.hasUI) { render(ctx); return; }
        if (!state.goal) args = (await ctx.ui.input("Goal", "What should Pi complete?"))?.trim() ?? "";
        else args = (await ctx.ui.select(`${state.goal.status}: ${state.goal.objective}`, ["status", "pause", "resume", "clear"])) ?? "";
        if (!args) return;
      }
      if (args === "status") { render(ctx); ctx.ui.notify(state.goal ? `${state.goal.status}: ${state.goal.objective}` : "No goal. Use /goal <objective>.", "info"); return; }
      if (args === "pause") { pause(ctx, "Paused by user; the current response may finish."); return; }
      if (args === "clear") {
        state.goal = null;
        save(ctx);
        return;
      }
      if (args.startsWith("budget ")) {
        const budget = parseTokenBudget(args.slice(7).trim());
        if (!state.goal || !budget) throw new Error("Use /goal budget <positive token count>, for example 100k.");
        state.goal.tokenBudget = budget;
        save(ctx);
        return;
      }
      if (args === "resume") {
        const goal = state.goal;
        if (!goal || goal.status === "complete") throw new Error("Create a new goal with /goal <objective>.");
        if (goal.status === "active") return;
        if (goal.tokenBudget && goal.tokens >= goal.tokenBudget) throw new Error("Token budget reached. Increase it with /goal budget <tokens> before resuming.");
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current response and queued messages before resuming.");
        if (isPlanToolSelection(pi.getActiveTools())) throw new Error("Review the plan and use /plan execute before resuming the goal.");
        goal.status = "active";
        goal.automaticRuns = 0;
        delete goal.reason;
        repeatedRuns = 0;
        lastOutput = "";
        ensureGoalTools();
        save(ctx);
        send(`Resume the goal: ${goal.objective}`);
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current response before starting a goal.");
      if (isPlanToolSelection(pi.getActiveTools())) throw new Error("Finish reviewing the plan before starting a goal.");
      let tokenBudget: number | undefined;
      if (args.startsWith("--tokens")) {
        const match = /^--tokens\s+(\S+)\s+([\s\S]+)$/.exec(args);
        const parsed = match && parseTokenBudget(match[1]);
        if (!match || !parsed) throw new Error("Use /goal --tokens 100k <objective>.");
        tokenBudget = parsed;
        args = match[2].trim();
      }
      if (!args || args.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
      if (state.goal && state.goal.status !== "complete") {
        if (!ctx.hasUI || !await ctx.ui.confirm("Replace the current goal?", state.goal.objective)) return;
      }
      state.goal = { id: randomUUID(), objective: args, status: "active", tokens: 0, automaticRuns: 0, ...(tokenBudget ? { tokenBudget } : {}) };
      lastOutput = "";
      repeatedRuns = 0;
      ensureGoalTools();
      save(ctx);
      send(`Complete this goal: ${args}`);
    };

    const planCommand = async (raw: string, ctx: ExtensionContext) => {
      let args = raw.trim();
      if (!args) {
        if (!ctx.hasUI) { render(ctx); return; }
        args = state.plan
          ? (await ctx.ui.select(state.plan.title, ["status", "execute", "refine", "cancel"])) ?? ""
          : (await ctx.ui.input("Plan", "What should Pi plan?"))?.trim() ?? "";
        if (!args) return;
      }
      if (args === "status") { render(ctx); return; }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current response before changing the plan.");
      if (args === "cancel") {
        if (state.plan && isPlanToolSelection(pi.getActiveTools())) pi.setActiveTools(state.plan.previousTools);
        state.plan = null;
        save(ctx);
        return;
      }
      if (args === "execute") {
        if (!state.plan?.steps.length || state.plan.status !== "ready") throw new Error("Create and review a ready plan first.");
        state.plan.status = "executing";
        pi.setActiveTools([...new Set([...state.plan.previousTools, "update_plan"])]);
        save(ctx);
        send(`Execute the reviewed plan: ${state.plan.title}\n${state.plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join("\n")}\nUpdate plan progress with update_plan; verify before marking steps completed.`);
        return;
      }
      const refining = args === "refine" || args.startsWith("refine ");
      if (refining && !state.plan) throw new Error("Create a plan before refining it.");
      if (args === "refine") {
        args = (await ctx.ui.input("Refine plan", "What should change?"))?.trim() ?? "";
        if (!args) return;
      } else if (args.startsWith("refine ")) args = args.slice(7).trim();
      if (!args || args.length > 4000) throw new Error("Plan request must contain 1–4000 characters.");
      pause(ctx, "Goal paused while reviewing a plan. Resume after /plan execute.");
      const activeTools = pi.getActiveTools();
      const previousTools = isPlanToolSelection(activeTools)
        ? state.plan?.previousTools ?? [...TOOL_PRESET_DEFAULT]
        : activeTools;
      state.plan = {
        title: refining ? state.plan!.title : args.slice(0, 500), status: "planning",
        steps: refining ? state.plan!.steps.map(step => ({ ...step, status: "pending" })) : [], previousTools,
      };
      pi.setActiveTools([...TOOL_PRESET_PLAN]);
      save(ctx);
      send(`${refining ? "Refine the saved plan with this change" : "Prepare an implementation plan for"}: ${args}\nExplore only; do not implement. Save ordered steps with update_plan, then summarize the plan for review.`);
    };

    // Serialize management dialogs so a delayed answer cannot replace newer state.
    const command = (handler: typeof goalCommand) => async (args: string, ctx: ExtensionContext) => {
      if (handler === goalCommand && args.trim() === "pause") { pause(ctx, "Paused by user; the current response may finish."); return; }
      if (commandBusy) throw new Error("Finish the open Goal/Plan action first.");
      commandBusy = true;
      try { await handler(args, ctx); } finally { commandBusy = false; continueGoal(ctx); }
    };
    pi.registerCommand("goal", { description: "Manage a persistent goal: start, pause, resume, status, budget, clear", handler: command(goalCommand) });
    pi.registerCommand("plan", { description: "Create, review, refine and execute a saved plan", handler: command(planCommand) });

    pi.registerTool(defineTool({
      name: "update_plan", label: "Update plan",
      description: "Save the ordered plan or update verified progress. Planning never starts execution.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), steps: Type.Array(Type.Object({
        text: Type.String({ minLength: 1, maxLength: 1000 }),
        status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
      }), { minItems: 1, maxItems: 30 }) }),
      async execute(_id, params, _signal, _update, ctx) {
        if (params.steps.filter(s => s.status === "in_progress").length > 1) throw new Error("Keep at most one step in progress.");
        const planning = isPlanToolSelection(pi.getActiveTools());
        if (planning && params.steps.some(s => s.status !== "pending")) throw new Error("Planning steps remain pending until execution is requested.");
        state.plan = {
          title: params.title, steps: params.steps,
          status: planning ? "ready" : params.steps.every(s => s.status === "completed") ? "complete" : "executing",
          previousTools: state.plan?.previousTools ?? (planning ? [...TOOL_PRESET_DEFAULT] : pi.getActiveTools().filter(t => t !== "update_plan")),
        };
        save(ctx);
        return { content: [{ type: "text", text: `Plan saved: ${state.plan.status}. ${planning ? "Wait for the user to request /plan execute." : ""}` }], details: structuredClone(state.plan) };
      },
    }));
    pi.registerTool(defineTool({
      name: "goal_status", label: "Goal status",
      description: "Mark the active goal complete with verification evidence, or blocked with a concrete impediment. Never claim completion with unfinished work.",
      parameters: Type.Object({ goalId: Type.String(), status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]), evidence: Type.String({ minLength: 8, maxLength: 4000 }) }),
      async execute(_id, params, _signal, _update, ctx) {
        const goal = state.goal;
        if (!goal || goal.id !== params.goalId || goal.status !== "active") throw new Error("No matching active goal; do not change a paused or replaced goal.");
        if (params.status === "complete" && state.plan?.steps.some(s => s.status !== "completed")) throw new Error("Verify and complete the remaining plan steps first.");
        goal.status = params.status;
        goal.reason = params.evidence;
        save(ctx);
        return { content: [{ type: "text", text: `Goal ${params.status}: ${params.evidence}` }], details: structuredClone(goal) };
      },
    }));

    pi.on("before_agent_start", (event) => {
      const instructions: string[] = [];
      if (state.goal?.status === "active") instructions.push(
        `Active goal (id ${state.goal.id}): ${state.goal.objective}`,
        "Continue concrete work within the user's authorization. Use goal_status only after verifying completion or identifying a concrete blocker. Do not ask for confirmation of routine authorized work. A goal does not authorize new purchases, publication or destructive changes.",
        `Token usage: ${state.goal.tokens}${state.goal.tokenBudget ? ` / ${state.goal.tokenBudget}` : " (no token budget set)"}.`,
      );
      if (state.plan) instructions.push(`Saved plan (${state.plan.status}): ${state.plan.title}\n${state.plan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join("\n")}\nUse update_plan for plan changes and verified progress. Planning and ready plans require a user request before execution.`);
      return instructions.length ? { systemPrompt: `${event.systemPrompt}\n\n${instructions.join("\n")}` } : undefined;
    });
    pi.on("agent_start", () => { generation++; runSettled = false; pendingContinuation = false; runOutput = ""; runHadTools = false; runGoalId = state.goal?.status === "active" ? state.goal.id : undefined; });
    pi.on("ui_prompt_start", () => { pendingDialogs++; });
    pi.on("ui_prompt_end", (_event, ctx) => { pendingDialogs = Math.max(0, pendingDialogs - 1); continueGoal(ctx); });
    pi.on("tool_call", (_event, ctx) => {
      runHadTools = true;
      if (state.goal?.status === "budget_limited" && state.goal.id === runGoalId) return { block: true, reason: "Goal token budget reached. Wait for the user.", terminate: true };
      if (state.goal?.status === "active" && isPlanToolSelection(pi.getActiveTools())) pause(ctx, "Plan mode selected. Review the plan before resuming.");
    });
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const message = event.message;
      runOutput = message.content.filter(b => b.type === "text").map(b => b.type === "text" ? b.text : "").join("\n").trim();
      if (!state.goal || state.goal.id !== runGoalId) return;
      state.goal.tokens += Math.max(0, message.usage.input + message.usage.output);
      if (message.stopReason === "aborted" || message.stopReason === "error") pause(ctx, message.stopReason === "aborted" ? "Stopped by user." : "Model error. Resolve it before resuming.");
      if (state.goal.status === "active" && state.goal.tokenBudget && state.goal.tokens >= state.goal.tokenBudget) {
        state.goal.status = "budget_limited";
        state.goal.reason = "Token budget reached. Usage is checked after each model response.";
      }
      save(ctx);
    });
    function continueGoal(ctx: ExtensionContext) {
      if (!runSettled || commandBusy || settledGeneration === generation || pendingContinuation) return;
      const goal = state.goal;
      if (goal?.status !== "active") return;
      if (pendingDialogs || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      settledGeneration = generation;
      if (isPlanToolSelection(pi.getActiveTools()) || !pi.getActiveTools().includes("goal_status")) { pause(ctx, "Tool selection changed. Review it before resuming."); return; }
      repeatedRuns = !runHadTools && (!runOutput || runOutput === lastOutput) ? repeatedRuns + 1 : 0;
      lastOutput = runOutput;
      if (repeatedRuns >= 3 || goal.automaticRuns >= GOAL_AUTOMATIC_RUN_LIMIT) {
        pause(ctx, repeatedRuns >= 3 ? "Repeated responses without progress. Review before resuming." : "25 automatic continuations completed. Review before resuming.");
        return;
      }
      goal.automaticRuns++;
      save(ctx);
      send(`Continue the active goal: ${goal.objective}\nMake concrete progress and verify the result. Use goal_status with id ${goal.id} when complete or blocked.`, true);
    }
    pi.on("agent_settled", (_event, ctx) => { runSettled = true; continueGoal(ctx); });
  } };
}
