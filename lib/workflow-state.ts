export const WORKFLOW_ENTRY = "pi-web-workflow-v1";

export interface GoalState {
  id: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "budget_limited" | "complete";
  tokens: number;
  tokenBudget?: number;
  automaticRuns: number;
  automaticRunLimit?: number; // 0 or omitted: no fixed continuation cap
  reason?: string;
}

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanState {
  title: string;
  status: "planning" | "ready" | "executing" | "complete";
  steps: PlanStep[];
  previousTools: string[];
}

export interface WorkflowState {
  version: 1;
  goal: GoalState | null;
  plan: PlanState | null;
}

export function emptyWorkflow(): WorkflowState {
  return { version: 1, goal: null, plan: null };
}

/** Custom session entries are untrusted disk data, including imported sessions. */
export function readWorkflow(value: unknown): WorkflowState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as WorkflowState;
  if (state.version !== 1) return null;
  const g = state.goal;
  if (g !== null && (!g || typeof g.id !== "string" || typeof g.objective !== "string"
    || g.objective.length > 4000 || !["active", "paused", "blocked", "budget_limited", "complete"].includes(g.status)
    || !Number.isSafeInteger(g.tokens) || g.tokens < 0 || !Number.isSafeInteger(g.automaticRuns) || g.automaticRuns < 0
    || (g.tokenBudget !== undefined && (!Number.isSafeInteger(g.tokenBudget) || g.tokenBudget <= 0))
    || (g.automaticRunLimit !== undefined && (!Number.isSafeInteger(g.automaticRunLimit) || g.automaticRunLimit < 0))
    || (g.reason !== undefined && typeof g.reason !== "string"))) return null;
  const p = state.plan;
  if (p !== null && (!p || typeof p.title !== "string" || p.title.length > 500
    || !["planning", "ready", "executing", "complete"].includes(p.status)
    || !Array.isArray(p.previousTools) || !p.previousTools.every(t => typeof t === "string")
    || !Array.isArray(p.steps) || p.steps.length > 30 || !p.steps.every(s => s && typeof s.text === "string"
      && s.text.length <= 1000 && ["pending", "in_progress", "completed"].includes(s.status)))) return null;
  return structuredClone(state);
}

export function parseTokenBudget(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1000 : 1);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function parseWorkflowCommand(message: string): { command: "goal" | "plan"; args: string } | null {
  const match = /^\/(goal|plan)(?:\s+([\s\S]*))?$/.exec(message.trim());
  return match ? { command: match[1] as "goal" | "plan", args: match[2]?.trim() ?? "" } : null;
}
