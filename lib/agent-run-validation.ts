import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentRunInput } from "./agent-run-types";
import { isAgentRunLimits } from "./agent-run-limits";
import type { AgentRunLimits } from "./agent-run-types";
import {
  isAgentRunConcurrency,
  MAX_AGENT_RUN_CONCURRENCY,
  MIN_AGENT_RUN_CONCURRENCY,
} from "./agent-run-types";
import {
  ALLOWED_SCHEDULE_TOOLS,
  DEFAULT_SCHEDULE_TOOLS,
} from "./schedule-validation";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export class AgentRunValidationError extends Error {}

export interface AgentRunConfigInput {
  maxConcurrency: number;
  subagentLimits?: AgentRunLimits;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentRunValidationError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentRunValidationError(`${field} is too long`);
  }
  return normalized;
}

export async function validateAgentRunInput(value: unknown): Promise<AgentRunInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRunValidationError("JSON object is required");
  }
  const input = value as Record<string, unknown>;
  const name = requiredString(input.name, "name", 100);
  const cwd = requiredString(input.cwd, "cwd", 4_096);
  const prompt = requiredString(input.prompt, "prompt", 200_000);

  if (!isAbsolute(cwd)) throw new AgentRunValidationError("cwd must be absolute");
  try {
    if (!(await stat(cwd)).isDirectory()) {
      throw new AgentRunValidationError("cwd must be a directory");
    }
  } catch (error) {
    if (error instanceof AgentRunValidationError) throw error;
    throw new AgentRunValidationError("cwd does not exist");
  }

  const provider = input.provider === undefined || input.provider === ""
    ? undefined
    : requiredString(input.provider, "provider", 200);
  const modelId = input.modelId === undefined || input.modelId === ""
    ? undefined
    : requiredString(input.modelId, "modelId", 500);
  if (!!provider !== !!modelId) {
    throw new AgentRunValidationError("provider and modelId must be set together");
  }

  const thinkingLevel = input.thinkingLevel === undefined
    || input.thinkingLevel === ""
    || input.thinkingLevel === "auto"
    ? undefined
    : requiredString(input.thinkingLevel, "thinkingLevel", 20);
  if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
    throw new AgentRunValidationError("Unsupported thinking level");
  }

  const toolNames = input.toolNames === undefined
    ? [...DEFAULT_SCHEDULE_TOOLS]
    : Array.isArray(input.toolNames)
      ? [...new Set(input.toolNames)]
      : null;
  if (!toolNames || toolNames.some((tool) => (
    typeof tool !== "string" || !ALLOWED_SCHEDULE_TOOLS.has(tool)
  ))) {
    throw new AgentRunValidationError("toolNames contains an unsupported tool");
  }

  return {
    name,
    cwd,
    prompt,
    provider,
    modelId,
    thinkingLevel,
    toolNames: toolNames as string[],
  };
}

export function validateAgentRunConfigInput(value: unknown): AgentRunConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRunValidationError("JSON object is required");
  }
  const maxConcurrency = (value as Record<string, unknown>).maxConcurrency;
  if (!isAgentRunConcurrency(maxConcurrency)) {
    throw new AgentRunValidationError(
      `maxConcurrency must be an integer between ${MIN_AGENT_RUN_CONCURRENCY} and ${MAX_AGENT_RUN_CONCURRENCY}`,
    );
  }
  const subagentLimits = (value as Record<string, unknown>).subagentLimits;
  if (subagentLimits !== undefined && !isAgentRunLimits(subagentLimits)) throw new AgentRunValidationError("Invalid subagent limits");
  return { maxConcurrency, ...(subagentLimits !== undefined ? { subagentLimits: subagentLimits as AgentRunLimits } : {}) };
}
