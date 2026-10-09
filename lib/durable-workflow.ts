import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc, defineDoc, defineExtension, defineTool, GenerationTask, hook, InboxDoc, LiveDoc, section, ToolTask,
  type Conversation, type ConversationId, type Harness, type HookApi, type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai-durable";
import { isPlanReadOnlyCommand, isPlanToolSelection, PLAN_MODE_PROMPT } from "./plan-mode";
import { TOOL_PRESET_DEFAULT, TOOL_PRESET_PLAN } from "./tool-selection";
import { emptyWorkflow, parseTokenBudget, parseWorkflowCommand, type WorkflowState } from "./workflow-state";
import type { WebExtensionUIEvent } from "./web-extension-ui-types";

type Goal = {
  id: string; objective: string; status: "active" | "paused" | "blocked" | "budget_limited" | "complete";
  tokens: number; automaticRuns: number; tokenBudget?: number; automaticRunLimit?: number; reason?: string;
};
type Plan = {
  title: string; status: "planning" | "ready" | "executing" | "complete";
  steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
  previousTools: string[];
};
type GoalRun = { goalId: string | null; epoch: number };
type WorkflowDocument = {
  version: 1; goal: Goal | null; plan: Plan | null; epoch: number;
  lastOutput: string; repeatedRuns: number; toolProgress: boolean;
  responses: Record<string, boolean>; generations: Record<string, GoalRun>;
  runGoals: Record<string, GoalRun>; planResults: Record<string, Plan>; goalResults: Record<string, Goal>;
  continuations: Record<string, { goalId: string; epoch: number; text: string | null }>;
  pendingCommand: { requestId: string; text: string } | null;
};

/** Forks receive the state at their branch point, not the latest parent state. */
export const DurableWorkflowDoc = defineDoc<WorkflowDocument>({
  kind: "pi-web.workflow", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
  initial: () => ({ ...emptyWorkflow(), epoch: 0, lastOutput: "", repeatedRuns: 0, toolProgress: false,
    responses: {}, generations: {}, runGoals: {}, planResults: {}, goalResults: {}, continuations: {}, pendingCommand: null }),
});

export interface DurableWorkflowUI {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}
export interface DurableWorkflowOptions {
  harness: () => Harness;
  /** Host model admission must enforce blockReason: native beforeRequest hooks are advisory. */
  beforeRequest?: (request: { conversationId: ConversationId; taskId: TaskId; blockReason?: string }) => void | Promise<void>;
}

export async function readDurableWorkflow(harness: Harness, conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<WorkflowState> {
  const state = await harness.snapshot(DurableWorkflowDoc, conversationId, context);
  return state ? structuredClone({ version: state.version, goal: state.goal, plan: state.plan }) : emptyWorkflow();
}

/** Existing Web extension UI protocol; callers publish this after committed doc changes. */
export function durableWorkflowUIEvents(state: WorkflowState): WebExtensionUIEvent[] {
  const goal = state.goal && !["complete", "blocked"].includes(state.goal.status) ? state.goal : null;
  const plan = state.plan;
  return [
    { type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "Goal", statusText: goal ? `${goal.status} · ${goal.tokens.toLocaleString()}${goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} tokens` : undefined },
    { type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: "Goal", widgetLines: goal ? [goal.objective, ...(goal.reason ? [goal.reason] : []), "/goal · /goal pause · /goal resume · /goal runs <count>"] : undefined },
    { type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "Plan", statusText: plan ? `${plan.status} · ${plan.steps.filter(step => step.status === "completed").length}/${plan.steps.length}` : undefined },
    { type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: "Plan", widgetLines: plan ? [plan.title, ...plan.steps.map((step, index) => `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : "○"} ${index + 1}. ${step.text}`), "/plan · /plan execute · /plan cancel"] : undefined },
  ];
}

/** Call on explicit user stop or a user-selected branch/reopen, never on crash recovery. */
export async function pauseDurableWorkflow(conversation: Conversation, reason = "Paused by user; the current response may finish.", context: Context = BACKGROUND_CONTEXT): Promise<void> {
  await conversation.commit(async tx => {
    const state = await tx.doc(DurableWorkflowDoc, conversation.id);
    if (state.goal?.status === "active") { state.goal.status = "paused"; state.goal.reason = reason; }
    state.pendingCommand = null;
  }, context);
}

/** Complete a command admitted before a process interruption, without submitting twice. */
export async function flushDurableWorkflowCommand(conversation: Conversation, harness: Harness, context: Context = BACKGROUND_CONTEXT): Promise<void> {
  const pending = (await harness.snapshot(DurableWorkflowDoc, conversation.id, context))?.pendingCommand;
  if (!pending) return;
  await conversation.submit({ type: "input", content: pending.text, requestId: pending.requestId }, context);
  await conversation.commit(async tx => {
    const state = await tx.doc(DurableWorkflowDoc, conversation.id);
    if (state.pendingCommand?.requestId === pending.requestId) state.pendingCommand = null;
  }, context);
}

const isPlanning = (plan: Plan | null | undefined) => plan?.status === "planning" || plan?.status === "ready";
// Chord drafts are proxies; structuredClone cannot detach them inside a commit.
const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Model-admission guard scoped to the generation that actually belongs to the goal. */
export async function durableWorkflowRequestBlockReason(harness: Harness, conversationId: ConversationId, taskId?: TaskId, context: Context = BACKGROUND_CONTEXT): Promise<string | undefined> {
  const state = await harness.snapshot(DurableWorkflowDoc, conversationId, context);
  const run = taskId ? state?.generations[String(taskId)] : undefined;
  if (state?.goal?.status === "budget_limited" && run?.goalId === state.goal.id && run.epoch === state.epoch) return "Goal token budget reached. Wait for the user.";
  return undefined;
}

export function createDurableWorkflowExtension(options: DurableWorkflowOptions) {
  const requestRun = async (api: HookApi, context: Context) => {
    const harness = options.harness();
    const state = await harness.snapshot(DurableWorkflowDoc, api.conversationId, context);
    const live = await harness.snapshot(LiveDoc, api.conversationId, context);
    const runKey = live?.run?.inputs.join(":") ?? String(api.taskId);
    const run = await api.memo<GoalRun>("pi-web.workflow.goal", state?.runGoals[runKey] ?? {
      goalId: state?.goal?.status === "active" ? state.goal.id : null, epoch: state?.epoch ?? 0,
    }, context);
    await harness.commit(async tx => {
      const saved = await tx.doc(DurableWorkflowDoc, api.conversationId);
      saved.generations[String(api.taskId)] = run;
      saved.runGoals[runKey] = run;
    }, context);
    return run;
  };
  return defineExtension({
    name: "pi-web-workflow",
    sections: [section("pi_web_workflow", async (input, context) => {
      const state = await input.read.snapshot(DurableWorkflowDoc, input.conversationId, context);
      if (!state) return undefined;
      const parts: string[] = [];
      if (isPlanning(state.plan) || isPlanToolSelection(input.agent.tools.map(tool => tool.name))) parts.push(PLAN_MODE_PROMPT);
      if (state.goal?.status === "active") parts.push(
        `Active goal (id ${state.goal.id}): ${state.goal.objective}`,
        "Continue concrete work within the user's authorization. Use goal_status only after verified completion or a concrete blocker. A goal does not authorize new purchases, publication or destructive changes.",
        `Token usage: ${state.goal.tokens}${state.goal.tokenBudget ? ` / ${state.goal.tokenBudget}` : " (no token budget set)"}.`,
      );
      if (state.plan) parts.push(`Saved plan (${state.plan.status}): ${state.plan.title}\n${state.plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.text}`).join("\n")}\nUse update_plan for verified progress. Planning and ready plans require /plan execute before implementation.`);
      return parts.join("\n\n") || undefined;
    }, { tag: false })],
    tools: [
      defineTool({
        name: "update_plan", description: "Save ordered plan steps or verified progress. Planning never starts execution.", replay: "safe", executionMode: "sequential",
        parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), steps: Type.Array(Type.Object({ text: Type.String({ minLength: 1, maxLength: 1000 }), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]) }), { minItems: 1, maxItems: 30 }) }),
        async execute(args, api, context) {
          const agent = await api.agent(context);
          const result = await api.commit(async tx => {
            const state = await tx.doc(DurableWorkflowDoc, api.conversationId);
            const prior = state.planResults[String(api.taskId)];
            if (prior) return detached(prior);
            const planning = isPlanning(state.plan) || isPlanToolSelection(agent.tools.map(tool => tool.name));
            if (planning && args.steps.some(step => step.status !== "pending")) throw new Error("Planning steps remain pending until execution is requested.");
            state.plan = { title: args.title, steps: args.steps, status: planning ? "ready" : args.steps.every(step => step.status === "completed") ? "complete" : "executing", previousTools: state.plan?.previousTools ?? agent.tools.map(tool => tool.name).filter(name => name !== "update_plan") };
            state.planResults[String(api.taskId)] = detached(state.plan);
            return detached(state.plan);
          }, context);
          return { content: [{ type: "text", text: `Plan saved: ${result.status}.` }], details: result };
        },
      }),
      defineTool({
        name: "goal_status", description: "Mark the matching active goal complete with verification evidence or blocked with a concrete impediment.", replay: "safe", executionMode: "sequential",
        parameters: Type.Object({ goalId: Type.String(), status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]), evidence: Type.String({ minLength: 8, maxLength: 4000 }) }),
        async execute(args, api, context) {
          const result = await api.commit(async tx => {
            const state = await tx.doc(DurableWorkflowDoc, api.conversationId);
            const prior = state.goalResults[String(api.taskId)];
            if (prior) return detached(prior);
            const goal = state.goal;
            if (!goal || goal.id !== args.goalId) throw new Error("No matching active goal.");
            // Replay of the same committed outcome is safe; a stale task cannot replace a newer decision.
            if (goal.status === args.status && goal.reason === args.evidence) return detached(goal);
            if (goal.status !== "active") throw new Error("Do not change a paused or replaced goal.");
            if (args.status === "complete" && state.plan?.steps.some(step => step.status !== "completed")) throw new Error("Verify and complete the remaining plan steps first.");
            goal.status = args.status; goal.reason = args.evidence;
            state.goalResults[String(api.taskId)] = detached(goal);
            return detached(goal);
          }, context);
          return { content: [{ type: "text", text: `Goal ${args.status}: ${args.evidence}` }], details: result };
        },
      }),
      defineTool({
        name: "structured_output", description: "Finish the current turn with a compact result card. Use only as the final action.", replay: "safe", executionMode: "sequential",
        parameters: Type.Object({ headline: Type.String(), summary: Type.String(), actionItems: Type.Array(Type.String(), { maxItems: 12 }), kind: Type.Optional(Type.Union([Type.Literal("result"), Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")])), details: Type.Optional(Type.String()) }),
        async execute(args, api, context) {
          const details = { headline: args.headline.trim(), summary: args.summary.trim(), actionItems: args.actionItems.map(item => item.trim()).filter(Boolean), kind: args.kind ?? "result", ...(args.details?.trim() ? { details: args.details.trim() } : {}) };
          const workflow = await api.snapshot(DurableWorkflowDoc, api.conversationId, context);
          return { content: [{ type: "text", text: `Structured result: ${details.headline}` }], details, ...(workflow?.goal?.status === "active" ? {} : { control: { terminate: true as const } }) };
        },
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          await requestRun(api, context);
          const blockReason = await durableWorkflowRequestBlockReason(options.harness(), api.conversationId, api.taskId, context);
          await options.beforeRequest?.({ conversationId: api.conversationId, taskId: api.taskId, blockReason });
          return undefined;
        },
        afterResponse: async (message, api, context) => {
          const run = await api.memo<GoalRun>("pi-web.workflow.goal", context);
          if (!run?.goalId) return;
          const responseKey = createHash("sha256").update(JSON.stringify([api.taskId, message.responseId, message.timestamp, message.stopReason, message.content, message.usage])).digest("hex");
          await options.harness().commit(async tx => {
            const state = await tx.doc(DurableWorkflowDoc, api.conversationId);
            if (state.responses[responseKey] || state.goal?.id !== run.goalId || state.epoch !== run.epoch) return;
            state.responses[responseKey] = true;
            state.goal.tokens += Math.max(0, message.usage.input + message.usage.output);
            if (["aborted", "error"].includes(message.stopReason) && state.goal.status === "active") {
              state.goal.status = "paused"; state.goal.reason = message.stopReason === "aborted" ? "Stopped by user." : "Model error. Resolve it before resuming.";
            }
            if (state.goal.status === "active" && state.goal.tokenBudget && state.goal.tokens >= state.goal.tokenBudget) {
              state.goal.status = "budget_limited"; state.goal.reason = "Token budget reached. Usage is checked after each model response.";
            }
          }, context);
        },
        afterTools: async (_assistant, _results, api, context) => {
          await options.harness().commit(async tx => { (await tx.doc(DurableWorkflowDoc, api.conversationId)).toolProgress = true; }, context);
        },
        onYield: async (answer, api, context) => {
          const run = await api.memo<GoalRun>("pi-web.workflow.goal", context);
          if (!run?.goalId) return;
          const text = await options.harness().commit(async tx => {
            const state = await tx.doc(DurableWorkflowDoc, api.conversationId);
            const goal = state.goal;
            if (!goal || goal.id !== run.goalId || state.epoch !== run.epoch || goal.status !== "active") return null;
            const prior = state.continuations[String(api.taskId)];
            if (prior) return prior.goalId === goal.id && prior.epoch === state.epoch ? prior.text : null;
            const inbox = await tx.doc(InboxDoc, api.conversationId);
            if (inbox.items.some(item => item.mode !== "write")) return null;
            const agent = await tx.doc(AgentDoc, api.conversationId);
            if (isPlanning(state.plan) || (Array.isArray(agent.tools) && !agent.tools.includes("goal_status"))) {
              goal.status = "paused"; goal.reason = "Tool selection changed. Review it before resuming."; return null;
            }
            const output = answer.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
            state.repeatedRuns = !state.toolProgress && (!output || output === state.lastOutput) ? state.repeatedRuns + 1 : 0;
            state.lastOutput = output; state.toolProgress = false;
            let continuation: string | null = null;
            if (state.repeatedRuns >= 3 || (goal.automaticRunLimit && goal.automaticRuns >= goal.automaticRunLimit)) {
              goal.status = "paused"; goal.reason = state.repeatedRuns >= 3 ? "Repeated responses without progress. Review before resuming." : `${goal.automaticRunLimit} automatic continuations completed. Use /goal runs to adjust the cap or /goal resume to continue.`;
            } else {
              goal.automaticRuns++;
              continuation = `Continue the active goal: ${goal.objective}\nMake concrete progress and verify the result. Use goal_status with id ${goal.id} when complete or blocked.`;
            }
            state.continuations[String(api.taskId)] = { goalId: goal.id, epoch: state.epoch, text: continuation };
            return continuation;
          }, context);
          return text ? { continue: text } : undefined;
        },
      }),
      hook(ToolTask, { beforeTool: async (call, api, context) => {
        const harness = options.harness();
        const owner = (await harness.getTask(api.taskId, context))?.owner;
        const blocked = await durableWorkflowRequestBlockReason(harness, api.conversationId, owner, context);
        if (blocked) return { block: blocked };
        const state = await api.snapshot(DurableWorkflowDoc, api.conversationId, context);
        const agent = await api.snapshot(AgentDoc, api.conversationId, context);
        if (!isPlanning(state?.plan) && !(Array.isArray(agent?.tools) && isPlanToolSelection(agent.tools))) return;
        if (!TOOL_PRESET_PLAN.includes(call.name as typeof TOOL_PRESET_PLAN[number])) return { block: "Plan mode is read-only. Use /plan execute before changing files or external systems." };
        if (call.name === "bash" && !isPlanReadOnlyCommand(String(call.arguments.command ?? ""))) return { block: "Plan mode blocked a command outside the read-only allowlist." };
      } }),
    ],
  });
}

const commandLocks = new WeakMap<Harness, Set<ConversationId>>();
export async function handleDurableWorkflowCommand(
  conversation: Conversation, harness: Harness, message: string, context: Context = BACKGROUND_CONTEXT,
  options: { ui?: DurableWorkflowUI } = {},
): Promise<boolean> {
  const command = parseWorkflowCommand(message);
  if (!command) return false;
  if (command.command === "goal" && command.args === "pause") { await pauseDurableWorkflow(conversation, undefined, context); return true; }
  let busy = commandLocks.get(harness);
  if (!busy) { busy = new Set(); commandLocks.set(harness, busy); }
  if (busy.has(conversation.id)) throw new Error("Finish the open Goal/Plan action first.");
  busy.add(conversation.id);
  try { return await executeWorkflowCommand(conversation, harness, message, context, options); }
  finally { busy.delete(conversation.id); }
}

async function executeWorkflowCommand(
  conversation: Conversation, harness: Harness, message: string, context: Context = BACKGROUND_CONTEXT,
  options: { ui?: DurableWorkflowUI } = {},
): Promise<boolean> {
  const command = parseWorkflowCommand(message);
  if (!command) return false;
  const ui = options.ui;
  let args = command.args;
  const initial = await readDurableWorkflow(harness, conversation.id, context);
  if (!args) {
    if (!ui) return true;
    args = command.command === "goal"
      ? initial.goal ? await ui.select(`${initial.goal.status}: ${initial.goal.objective}`, ["status", "pause", "resume", "clear"]) ?? "" : await ui.input("Goal", "What should Pi complete?") ?? ""
      : initial.plan ? await ui.select(initial.plan.title, ["status", "execute", "refine", "cancel"]) ?? "" : await ui.input("Plan", "What should Pi plan?") ?? "";
    args = args.trim();
    if (!args) return true;
  }
  if (args === "status") { if (command.command === "goal") ui?.notify?.(initial.goal ? `${initial.goal.status}: ${initial.goal.objective}` : "No goal. Use /goal <objective>.", "info"); return true; }
  if (command.command === "goal" && args === "pause") { await pauseDurableWorkflow(conversation, undefined, context); return true; }
  const live = await harness.snapshot(LiveDoc, conversation.id, context);
  const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
  const management = command.command === "goal" && (args === "clear" || args.startsWith("runs ") || args.startsWith("budget "));
  if (!management && (live?.run || inbox?.items.some(item => item.mode !== "write"))) throw new Error("Wait for the current response and queued messages before changing the goal or plan.");
  if (command.command === "plan" && args === "refine") {
    if (!initial.plan) throw new Error("Create a plan before refining it.");
    const refinement = await ui?.input("Refine plan", "What should change?");
    if (!refinement?.trim()) return true;
    args = `refine ${refinement.trim()}`;
  }
  if (command.command === "goal" && !["resume", "clear"].includes(args) && !args.startsWith("runs ") && !args.startsWith("budget ") && initial.goal && initial.goal.status !== "complete") {
    if (!ui || !await ui.confirm("Replace the current goal?", initial.goal.objective)) return true;
  }
  const activeTools = (await conversation.agent(context)).tools.map(tool => tool.name);
  const expectedGoalId = initial.goal?.id;
  await conversation.commit(async tx => {
    const state = await tx.doc(DurableWorkflowDoc, conversation.id);
    if (state.goal?.id !== expectedGoalId) throw new Error("Goal changed while this action was open. Try again.");
    const agent = await tx.doc(AgentDoc, conversation.id);
    const send = (text: string) => { state.pendingCommand = { requestId: `workflow:${randomUUID()}`, text }; };
    if (command.command === "goal") {
      if (args === "clear") { state.goal = null; state.pendingCommand = null; return; }
      if (args.startsWith("runs ")) {
        const count = args.slice(5).trim();
        if (!state.goal || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) throw new Error("Use /goal runs <count>; 0 disables the continuation cap.");
        state.goal.automaticRunLimit = Number(count); return;
      }
      if (args.startsWith("budget ")) {
        const budget = parseTokenBudget(args.slice(7).trim());
        if (!state.goal || !budget) throw new Error("Use /goal budget <positive token count>, for example 100k.");
        state.goal.tokenBudget = budget; return;
      }
      if (isPlanning(state.plan) || isPlanToolSelection(activeTools)) throw new Error("Review the plan and use /plan execute before starting or resuming the goal.");
      if (args === "resume") {
        if (!state.goal || state.goal.status === "complete") throw new Error("Create a new goal with /goal <objective>.");
        if (state.goal.status === "active") return;
        if (state.goal.tokenBudget && state.goal.tokens >= state.goal.tokenBudget) throw new Error("Token budget reached. Increase it with /goal budget <tokens> before resuming.");
        state.goal.status = "active"; state.goal.automaticRuns = 0; delete state.goal.reason;
      } else {
        let tokenBudget: number | undefined;
        let automaticRunLimit: number | undefined;
        const seen = new Set<string>();
        while (args.startsWith("--")) {
          const match = /^(--tokens|--runs)\s+(\S+)\s+([\s\S]+)$/.exec(args);
          if (!match || seen.has(match[1])) throw new Error("Use /goal [--tokens 100k] [--runs 50] <objective>.");
          seen.add(match[1]);
          if (match[1] === "--tokens") { tokenBudget = parseTokenBudget(match[2]) ?? undefined; if (!tokenBudget) throw new Error("Token budget must be positive."); }
          else { if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(Number(match[2]))) throw new Error("Continuation limit must be a nonnegative integer."); automaticRunLimit = Number(match[2]); }
          args = match[3].trim();
        }
        if (!args || args.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
        state.goal = { id: randomUUID(), objective: args, status: "active", tokens: 0, automaticRuns: 0, ...(tokenBudget ? { tokenBudget } : {}), ...(automaticRunLimit !== undefined ? { automaticRunLimit } : {}) };
      }
      state.epoch++; state.lastOutput = ""; state.repeatedRuns = 0; state.toolProgress = false;
      agent.tools = [...new Set([...activeTools, "goal_status", "update_plan"])];
      send(`Complete this goal: ${state.goal.objective}`);
      return;
    }
    if (args === "cancel") { if (state.plan && isPlanning(state.plan)) agent.tools = [...state.plan.previousTools]; state.plan = null; return; }
    if (args === "execute") {
      if (!state.plan?.steps.length || state.plan.status !== "ready") throw new Error("Create and review a ready plan first.");
      state.plan.status = "executing"; agent.tools = [...new Set([...state.plan.previousTools, "update_plan"])];
      send(`Execute the reviewed plan: ${state.plan.title}\n${state.plan.steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n")}\nUpdate verified progress with update_plan.`); return;
    }
    const refining = args.startsWith("refine ");
    if (refining && !state.plan) throw new Error("Create a plan before refining it.");
    const request = refining ? args.slice(7).trim() : args;
    if (!request || request.length > 4000) throw new Error("Plan request must contain 1–4000 characters.");
    if (state.goal?.status === "active") { state.goal.status = "paused"; state.goal.reason = "Goal paused while reviewing a plan. Resume after /plan execute."; }
    state.plan = { title: refining ? state.plan!.title : request.slice(0, 500), status: "planning", steps: refining ? state.plan!.steps.map(step => ({ ...step, status: "pending" })) : [], previousTools: isPlanning(state.plan) ? [...state.plan!.previousTools] : activeTools.length ? activeTools : [...TOOL_PRESET_DEFAULT] };
    agent.tools = [...TOOL_PRESET_PLAN];
    send(`${refining ? "Refine the saved plan" : "Prepare an implementation plan"}: ${request}\nExplore only; do not implement. Save ordered steps with update_plan, then summarize for review.`);
  }, context);
  await flushDurableWorkflowCommand(conversation, harness, context);
  return true;
}
