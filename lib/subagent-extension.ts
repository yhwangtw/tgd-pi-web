import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  parseFrontmatter,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AgentRun,
  AgentRunCompletion,
  AgentRunInput,
  AgentRunWorkspace,
} from "./agent-run-types";
import type { AgentMessage } from "./types";

const MAX_TASKS = 8;
const MAX_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_LIMITS = {
  maxTurns: 24,
  maxCostUsd: 5,
  timeoutMs: 30 * 60_000,
} as const;

const ALLOWED_AGENT_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ask_user",
]);

export type SubagentScope = "builtin" | "user" | "project" | "all";
export type SubagentSource = "builtin" | "user" | "project";

export interface SubagentDefinition {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  systemPrompt: string;
  source: SubagentSource;
  filePath?: string;
}

export interface SubagentRunRequest {
  agent: SubagentDefinition;
  task: string;
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  onUpdate?: (run: AgentRun) => void;
}

export type SubagentExecutor = (
  request: SubagentRunRequest,
  options: SubagentRunOptions,
) => Promise<AgentRunCompletion>;

export const BUILTIN_SUBAGENTS: readonly SubagentDefinition[] = [
  {
    name: "scout",
    description: "Map relevant code and return evidence without changing files.",
    tools: ["read", "grep", "find", "ls"],
    source: "builtin",
    systemPrompt: [
      "You are the read-only scout subagent.",
      "Inspect the smallest relevant part of the workspace, trace symbols and dependencies, and report concrete evidence with file paths.",
      "Do not modify files. Do not delegate to another agent. Make reasonable assumptions instead of asking the user.",
    ].join(" "),
  },
  {
    name: "planner",
    description: "Turn evidence into a scoped, verifiable implementation plan.",
    tools: ["read", "grep", "find", "ls"],
    source: "builtin",
    systemPrompt: [
      "You are the read-only planner subagent.",
      "Inspect the existing implementation before planning. Produce a concise sequence of independently verifiable changes, risks, and tests.",
      "Do not modify files. Do not delegate to another agent. Make reasonable assumptions instead of asking the user.",
    ].join(" "),
  },
  {
    name: "worker",
    description: "Implement one bounded task and verify the result.",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    source: "builtin",
    systemPrompt: [
      "You are the implementation worker subagent.",
      "Inspect before editing, keep changes tightly scoped to the delegated task, preserve unrelated work, and run proportional verification.",
      "Do not publish, deploy, delete broad paths, or delegate to another agent. Make reasonable assumptions instead of asking the user.",
    ].join(" "),
  },
  {
    name: "reviewer",
    description: "Review correctness, regressions, security, and test coverage without editing.",
    tools: ["read", "bash", "grep", "find", "ls"],
    source: "builtin",
    systemPrompt: [
      "You are the read-only reviewer subagent.",
      "Review the delegated scope for concrete correctness, regression, security, accessibility, and testing issues. Rank findings by severity and cite file paths.",
      "Do not modify files. Do not delegate to another agent. Do not invent findings when the evidence is clean.",
    ].join(" "),
  },
] as const;

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

function normalizeTools(value: unknown, fallback: string[] = ["read", "grep", "find", "ls"]): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : fallback;
  const tools = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => ALLOWED_AGENT_TOOLS.has(item) && item !== "subagent");
  return [...new Set(tools)];
}

function loadAgents(dir: string, source: "user" | "project"): SubagentDefinition[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const agents: SubagentDefinition[] = [];
  for (const name of names) {
    const filePath = join(dir, name);
    try {
      const parsed = parseFrontmatter<AgentFrontmatter>(readFileSync(filePath, "utf8"));
      const agentName = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
      const description = typeof parsed.frontmatter.description === "string"
        ? parsed.frontmatter.description.trim()
        : "";
      if (!agentName || !description || !parsed.body.trim()) continue;
      agents.push({
        name: agentName.slice(0, 80),
        description: description.slice(0, 500),
        tools: normalizeTools(parsed.frontmatter.tools),
        ...(typeof parsed.frontmatter.model === "string" && parsed.frontmatter.model.trim()
          ? { model: parsed.frontmatter.model.trim().slice(0, 500) }
          : {}),
        systemPrompt: parsed.body.trim().slice(0, 40_000),
        source,
        filePath,
      });
    } catch {
      // One invalid agent definition must not hide the valid built-ins.
    }
  }
  return agents;
}

function nearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".pi", "agents");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverSubagents(cwd: string, scope: SubagentScope): SubagentDefinition[] {
  const agents = new Map(BUILTIN_SUBAGENTS.map((agent) => [agent.name, { ...agent, tools: [...agent.tools] }]));
  if (scope === "user" || scope === "all") {
    for (const agent of loadAgents(join(getAgentDir(), "agents"), "user")) agents.set(agent.name, agent);
  }
  if (scope === "project" || scope === "all") {
    const dir = nearestProjectAgentsDir(cwd);
    if (dir) for (const agent of loadAgents(dir, "project")) agents.set(agent.name, agent);
  }
  return [...agents.values()];
}

function finalAssistantText(messages: AgentMessage[] | undefined): string {
  if (!messages) return "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("\n")
      .trim();
  }
  return "";
}

function clipOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) return value;
  let clipped = value.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(clipped, "utf8") > MAX_OUTPUT_BYTES) clipped = clipped.slice(0, -1);
  return `${clipped}\n\n[Output truncated to ${MAX_OUTPUT_BYTES / 1024} KB.]`;
}

function resolveModel(
  configured: string | undefined,
  inherited: { provider: string; id: string } | undefined,
): { provider: string; id: string } | undefined {
  if (!configured) return inherited;
  const slash = configured.indexOf("/");
  if (slash > 0 && slash < configured.length - 1) {
    return { provider: configured.slice(0, slash), id: configured.slice(slash + 1) };
  }
  return inherited ? { provider: inherited.provider, id: configured } : undefined;
}

export function composeSubagentPrompt(agent: SubagentDefinition, task: string): string {
  return [
    `<delegated_role name="${agent.name}" source="${agent.source}">`,
    agent.systemPrompt,
    "</delegated_role>",
    "",
    "<delegated_task>",
    task.trim(),
    "</delegated_task>",
    "",
    "Complete only this task. End with a concise result, evidence, and any remaining risk.",
  ].join("\n");
}

async function defaultExecutor(
  request: SubagentRunRequest,
  options: SubagentRunOptions,
): Promise<AgentRunCompletion> {
  const [{ ensureAgentRunSupervisor }, { inspectAgentRunWorkspace }] = await Promise.all([
    import("./agent-run-supervisor"),
    import("./agent-run-workspace"),
  ]);
  const selectedModel = resolveModel(request.agent.model, request.model);
  const workspace: AgentRunWorkspace = await inspectAgentRunWorkspace(request.cwd);
  const input: AgentRunInput = {
    name: `${request.agent.name} · ${request.task.trim().replace(/\s+/g, " ").slice(0, 72)}`,
    cwd: request.cwd,
    prompt: composeSubagentPrompt(request.agent, request.task),
    toolNames: normalizeTools(request.agent.tools),
    workspace,
    limits: { ...DEFAULT_LIMITS },
    ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.id } : {}),
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
  };
  return ensureAgentRunSupervisor().enqueueAndWait(input, {
    trigger: "subagent",
    signal: options.signal,
    onUpdate: options.onUpdate,
  });
}

interface DelegateOutcome {
  agent: string;
  source: SubagentSource;
  task: string;
  run: AgentRun;
  output: string;
}

function outcomeDetails(mode: "single" | "parallel" | "chain", outcomes: DelegateOutcome[]) {
  return {
    mode,
    limits: DEFAULT_LIMITS,
    runs: outcomes.map((outcome) => ({
      agent: outcome.agent,
      source: outcome.source,
      task: outcome.task,
      runId: outcome.run.id,
      sessionId: outcome.run.sessionId,
      status: outcome.run.status,
      error: outcome.run.error,
      report: outcome.run.report,
    })),
  };
}

const TaskItem = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 80 }),
  task: Type.String({ minLength: 1, maxLength: 100_000 }),
});

const ScopeSchema = StringEnum(["builtin", "user", "project", "all"] as const, {
  default: "builtin",
  description: "Built-ins are always available. Add user or project agent definitions only when needed.",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
  tasks: Type.Optional(Type.Array(TaskItem, { minItems: 1, maxItems: MAX_TASKS })),
  chain: Type.Optional(Type.Array(TaskItem, { minItems: 1, maxItems: MAX_TASKS })),
  agentScope: Type.Optional(ScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

export function createSubagentExtension(options: {
  executor?: SubagentExecutor;
  discover?: typeof discoverSubagents;
} = {}): InlineExtension {
  const executor = options.executor ?? defaultExecutor;
  const discover = options.discover ?? discoverSubagents;
  return {
    name: "pi-web-subagent",
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: "subagent",
        label: "Subagent",
        description: [
          "Delegate a bounded task to an isolated Pi session that appears in the Agent dashboard.",
          "Use single mode (agent + task), parallel mode (tasks), or chain mode (chain; {previous} inserts prior output).",
          `Built-in agents: ${BUILTIN_SUBAGENTS.map((agent) => `${agent.name} — ${agent.description}`).join("; ")}`,
        ].join(" "),
        promptSnippet: "Delegate focused work to scout, planner, worker, or reviewer subagents.",
        promptGuidelines: [
          "Delegate only concrete, bounded work that benefits from isolated context; keep simple work in the current agent.",
          "Use scout/planner/reviewer for read-only work and worker for changes. Do not recursively delegate.",
        ],
        parameters: SubagentParams,
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const scope = (params.agentScope ?? "builtin") as SubagentScope;
          const agents = discover(ctx.cwd, scope);
          const byName = new Map(agents.map((agent) => [agent.name, agent]));
          const hasSingle = Boolean(params.agent && params.task);
          const hasParallel = Boolean(params.tasks?.length);
          const hasChain = Boolean(params.chain?.length);
          if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
            return {
              content: [{ type: "text", text: `Provide exactly one subagent mode. Available agents: ${agents.map((agent) => agent.name).join(", ")}.` }],
              details: outcomeDetails("single", []),
              isError: true,
            };
          }

          const requested = hasSingle
            ? [{ agent: params.agent as string, task: params.task as string }]
            : hasParallel
              ? params.tasks as Array<{ agent: string; task: string }>
              : params.chain as Array<{ agent: string; task: string }>;
          const unknown = [...new Set(requested.map((item) => item.agent).filter((name) => !byName.has(name)))];
          if (unknown.length) {
            return {
              content: [{ type: "text", text: `Unknown subagent: ${unknown.join(", ")}. Available agents: ${agents.map((agent) => agent.name).join(", ")}.` }],
              details: outcomeDetails(hasParallel ? "parallel" : hasChain ? "chain" : "single", []),
              isError: true,
            };
          }

          const projectAgents = requested
            .map((item) => byName.get(item.agent))
            .filter((agent): agent is SubagentDefinition => agent?.source === "project");
          if (projectAgents.length && (params.confirmProjectAgents ?? true) && !ctx.isProjectTrusted()) {
            if (!ctx.hasUI) {
              return {
                content: [{ type: "text", text: "Project-local subagents require an interactive trust confirmation." }],
                details: outcomeDetails(hasParallel ? "parallel" : hasChain ? "chain" : "single", []),
                isError: true,
              };
            }
            const approved = await ctx.ui.confirm(
              "Run project-local subagents?",
              `Agents: ${[...new Set(projectAgents.map((agent) => agent.name))].join(", ")}\n\nProject agent prompts are repository-controlled. Continue only for a trusted workspace.`,
            );
            if (!approved) {
              return {
                content: [{ type: "text", text: "Project-local subagents were cancelled." }],
                details: outcomeDetails(hasParallel ? "parallel" : hasChain ? "chain" : "single", []),
              };
            }
          }

          const inheritedModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
          const runOne = async (agentName: string, task: string, completed: DelegateOutcome[]) => {
            const agent = byName.get(agentName)!;
            const completion = await executor({
              agent,
              task,
              cwd: ctx.cwd,
              model: inheritedModel,
              thinkingLevel: ctx.thinkingLevel,
            }, {
              signal,
              onUpdate: (run) => {
                const active: DelegateOutcome = { agent: agent.name, source: agent.source, task, run, output: "" };
                onUpdate?.({
                  content: [{ type: "text", text: `${agent.name}: ${run.status}` }],
                  details: outcomeDetails(hasParallel ? "parallel" : hasChain ? "chain" : "single", [...completed, active]),
                });
              },
            });
            return {
              agent: agent.name,
              source: agent.source,
              task,
              run: completion.run,
              output: clipOutput(finalAssistantText(completion.messages) || completion.run.report?.summary || completion.run.error || "No output."),
            } satisfies DelegateOutcome;
          };

          if (hasSingle) {
            const outcome = await runOne(params.agent as string, params.task as string, []);
            const failed = outcome.run.status !== "completed";
            return {
              content: [{ type: "text", text: failed ? `${outcome.agent} failed: ${outcome.run.error || outcome.output}` : outcome.output }],
              details: outcomeDetails("single", [outcome]),
              ...(failed ? { isError: true } : {}),
            };
          }

          if (hasParallel) {
            const outcomes: DelegateOutcome[] = [];
            const results = await Promise.all((params.tasks as Array<{ agent: string; task: string }>).map(async (item) => {
              const result = await runOne(item.agent, item.task, outcomes);
              outcomes.push(result);
              return result;
            }));
            const failed = results.filter((result) => result.run.status !== "completed");
            const text = results.map((result) => `### ${result.agent} · ${result.run.status}\n\n${result.output}`).join("\n\n---\n\n");
            return {
              content: [{ type: "text", text: `${results.length - failed.length}/${results.length} subagents completed\n\n${text}` }],
              details: outcomeDetails("parallel", results),
              ...(failed.length ? { isError: true } : {}),
            };
          }

          const outcomes: DelegateOutcome[] = [];
          let previous = "";
          for (const item of params.chain as Array<{ agent: string; task: string }>) {
            const task = item.task.replace(/\{previous\}/g, previous);
            const outcome = await runOne(item.agent, task, outcomes);
            outcomes.push(outcome);
            if (outcome.run.status !== "completed") {
              return {
                content: [{ type: "text", text: `Chain stopped at ${outcome.agent}: ${outcome.run.error || outcome.output}` }],
                details: outcomeDetails("chain", outcomes),
                isError: true,
              };
            }
            previous = outcome.output;
          }
          return {
            content: [{ type: "text", text: outcomes.at(-1)?.output || "Chain completed without output." }],
            details: outcomeDetails("chain", outcomes),
          };
        },
      }));
    },
  };
}
