import type { AgentMessage } from "./types";
import type { WorkflowState } from "./workflow-state";
import { redactSensitiveText } from "./redaction";

export interface HintWorkflow {
  goal?: { objective: string; status: "active" | "paused" | "blocked" | "budget_limited" | "complete" };
  plan?: { title: string; status: "planning" | "ready" | "executing" | "complete";
    steps: { id: string; text: string; status: "pending" | "in_progress" | "completed" }[] };
}
export interface ComposerHintContext {
  earlierGoal: string;
  corrections: string[];
  planningOnly: boolean;
  workflow: HintWorkflow;
  evidence: { id: string; kind: "test" | "build" | "check" | "tool"; outcome: "succeeded" | "failed" | "unknown" }[];
}
type WorkflowUI = { statuses: Record<string, string>; widgets: Record<string, { lines: string[] }> };
export const hintText = (text: string, limit: number) => {
  const safe = redactSensitiveText(text).replace(/\x1b\[[0-9;]*m/g, "").trim();
  return safe.length <= limit ? safe : `${safe.slice(0, Math.ceil(limit / 2) - 1)}…${safe.slice(-Math.floor(limit / 2))}`;
};
function visibleText(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  return typeof message.content === "string" ? message.content
    : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}
export function summarizeHintWorkflow(state: WorkflowState): HintWorkflow {
  return {
    ...(state.goal ? { goal: { objective: hintText(state.goal.objective, 300), status: state.goal.status } } : {}),
    ...(state.plan ? { plan: { title: hintText(state.plan.title, 120), status: state.plan.status,
      steps: state.plan.steps.map((step, i) => ({ id: `plan${i}`, text: hintText(step.text, 90), status: step.status }))
        .sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed")).slice(0, 6) } } : {}),
  };
}
/** UI is a fallback only. Missing/hidden terminal cards mean unknown, never complete. */
function workflowFromUI(ui?: WorkflowUI): HintWorkflow {
  const goalStatus = ui?.statuses.Goal?.split(/\s/)[0];
  const planStatus = ui?.statuses.Plan?.split(/\s/)[0];
  const goal = ui?.widgets.Goal?.lines[0];
  const plan = ui?.widgets.Plan?.lines[0];
  return summarizeHintWorkflow({ version: 1,
    goal: goal && ["active", "paused", "blocked", "budget_limited", "complete"].includes(goalStatus ?? "")
      ? { id: "ui", objective: goal, status: goalStatus as NonNullable<WorkflowState["goal"]>["status"], tokens: 0, automaticRuns: 0 } : null,
    plan: plan && ["planning", "ready", "executing", "complete"].includes(planStatus ?? "")
      ? { title: plan, status: planStatus as NonNullable<WorkflowState["plan"]>["status"], previousTools: [],
        steps: (ui?.widgets.Plan?.lines.slice(1) ?? []).flatMap(line => {
          const match = /^([✓→○])\s+\d+\.\s+(.+)$/.exec(line);
          return match ? [{ text: match[2], status: (match[1] === "✓" ? "completed" : match[1] === "→" ? "in_progress" : "pending") as "completed" | "in_progress" | "pending" }] : [];
        }) } : null,
  });
}
/** Bounded deterministic extraction; raw commands, tool output and images never leave here. */
export function buildComposerHintContext(messages: AgentMessage[], ui?: WorkflowUI, planningOnly = false): ComposerHintContext {
  const recent = messages.slice(-200);
  const users = recent.filter(message => message.role === "user").map(visibleText);
  const corrections = users.filter(text => /保留|不要|不需要|只(?:要|能|做)|改成|改為|先別|暫不|其實|不是|instead|actually|do not|don.t|keep|only|rather than/i.test(text)).slice(-3).map(text => hintText(text, 200));
  const commands = new Map<string, string>();
  const executions = new Map<string, ComposerHintContext["evidence"][number]>();
  let sequence = 0;
  const lastUser = recent.findLastIndex(message => message.role === "user");
  for (const message of recent.slice(lastUser + 1)) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") commands.set(block.toolCallId, String(block.input.command ?? block.input.cmd ?? ""));
    }
    if (message.role !== "toolResult" && message.role !== "bashExecution") continue;
    const command = message.role === "bashExecution" ? message.command : commands.get(message.toolCallId) ?? "";
    const kind = /vitest|playwright|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(command) ? "test"
      : /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/.test(command) ? "build"
      : /\btsc\b|eslint|audit:/.test(command) ? "check" : "tool";
    // Only explicit execution metadata/exit receipts count; prose like 'passed' does not.
    const output = message.role === "toolResult" ? message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") : "";
    const receipt = /(?:^|\n)(?:Process exited with code|Exit code:)\s*(-?\d+)\s*(?:\n|$)/.exec(output);
    const exit = message.role === "bashExecution" ? message.exitCode : receipt ? Number(receipt[1]) : undefined;
    const failed = message.role === "toolResult" ? message.isError : message.cancelled;
    const task = command || (message.role === "toolResult" ? message.toolName ?? message.toolCallId : `shell${sequence}`);
    executions.delete(task);
    executions.set(task, { id: `e${sequence++}`, kind, outcome: failed || (typeof exit === "number" && exit !== 0) ? "failed" : exit === 0 ? "succeeded" : "unknown" });
  }
  const earlier = messages.find(message => message.role === "user" && visibleText(message).trim().length >= 12);
  return { earlierGoal: earlier ? hintText(visibleText(earlier), 300) : "", corrections,
    planningOnly, workflow: workflowFromUI(ui), evidence: [...executions.values()].slice(-6) };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
export function isHintContext(value: unknown): value is ComposerHintContext {
  if (!record(value) || JSON.stringify(value).length > 3000 || !text(value.earlierGoal, 300)
    || typeof value.planningOnly !== "boolean" || !Array.isArray(value.corrections) || value.corrections.length > 3
    || !value.corrections.every(v => text(v, 200)) || !record(value.workflow) || !Array.isArray(value.evidence) || value.evidence.length > 6) return false;
  const { goal, plan } = value.workflow;
  if (goal !== undefined && (!record(goal) || !text(goal.objective, 300) || !["active", "paused", "blocked", "budget_limited", "complete"].includes(String(goal.status)))) return false;
  if (plan !== undefined && (!record(plan) || !text(plan.title, 120) || !["planning", "ready", "executing", "complete"].includes(String(plan.status))
    || !Array.isArray(plan.steps) || plan.steps.length > 6 || !plan.steps.every(step => record(step) && /^plan\d{1,2}$/.test(String(step.id)) && text(step.text, 90) && ["pending", "in_progress", "completed"].includes(String(step.status))))) return false;
  return value.evidence.every(item => record(item) && /^e\d{1,3}$/.test(String(item.id)) && ["test", "build", "check", "tool"].includes(String(item.kind)) && ["succeeded", "failed", "unknown"].includes(String(item.outcome)));
}

export const normalizedHint = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
