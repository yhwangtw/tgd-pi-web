import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { nextScheduleRunAt, validateScheduleTiming } from "./schedule-core";
import type { ScheduleInput, ScheduleTiming } from "./schedule-types";
import { THINKING_LEVEL_OPTIONS } from "./thinking-levels";

export const DEFAULT_SCHEDULE_TOOLS = ["read", "grep", "find", "ls", "ask_user"];
export const ALLOWED_SCHEDULE_TOOLS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls", "ask_user",
]);
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_OPTIONS);

export class ScheduleValidationError extends Error {}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ScheduleValidationError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ScheduleValidationError(`${field} is too long`);
  }
  return normalized;
}

function timingFromUnknown(value: unknown): ScheduleTiming {
  if (!value || typeof value !== "object") throw new ScheduleValidationError("timing is required");
  const timing = value as Record<string, unknown>;
  if (timing.kind === "once") {
    return {
      kind: "once",
      date: requiredString(timing.date, "date", 10),
      time: requiredString(timing.time, "time", 5),
    };
  }
  if (timing.kind === "daily") {
    return { kind: "daily", time: requiredString(timing.time, "time", 5) };
  }
  if (timing.kind === "weekly") {
    if (!Array.isArray(timing.weekdays)) throw new ScheduleValidationError("weekdays are required");
    if (timing.weekdays.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)) {
      throw new ScheduleValidationError("weekdays must contain integers from 0 to 6");
    }
    return {
      kind: "weekly",
      time: requiredString(timing.time, "time", 5),
      weekdays: [...new Set(timing.weekdays as number[])]
        .sort((a, b) => a - b),
    };
  }
  if (timing.kind === "cron") {
    return { kind: "cron", expression: requiredString(timing.expression, "cron expression", 120) };
  }
  throw new ScheduleValidationError("Unsupported schedule type");
}

export async function validateScheduleInput(value: unknown): Promise<ScheduleInput> {
  if (!value || typeof value !== "object") throw new ScheduleValidationError("JSON object is required");
  const input = value as Record<string, unknown>;
  const name = requiredString(input.name, "name", 100);
  const cwd = requiredString(input.cwd, "cwd", 4_096);
  const prompt = requiredString(input.prompt, "prompt", 200_000);
  const timezone = requiredString(input.timezone, "timezone", 100);
  if (!isAbsolute(cwd)) throw new ScheduleValidationError("cwd must be absolute");
  try {
    if (!(await stat(cwd)).isDirectory()) throw new ScheduleValidationError("cwd must be a directory");
  } catch (error) {
    if (error instanceof ScheduleValidationError) throw error;
    throw new ScheduleValidationError("cwd does not exist");
  }

  const timing = timingFromUnknown(input.timing);
  try {
    validateScheduleTiming(timing, timezone);
  } catch (error) {
    throw new ScheduleValidationError(error instanceof Error ? error.message : String(error));
  }

  const provider = input.provider === undefined || input.provider === ""
    ? undefined
    : requiredString(input.provider, "provider", 200);
  const modelId = input.modelId === undefined || input.modelId === ""
    ? undefined
    : requiredString(input.modelId, "modelId", 500);
  if (!!provider !== !!modelId) {
    throw new ScheduleValidationError("provider and modelId must be set together");
  }

  const thinkingLevel = input.thinkingLevel === undefined || input.thinkingLevel === "" || input.thinkingLevel === "auto"
    ? undefined
    : requiredString(input.thinkingLevel, "thinkingLevel", 20);
  if (thinkingLevel && !THINKING_LEVELS.has(thinkingLevel)) {
    throw new ScheduleValidationError("Unsupported thinking level");
  }

  const toolNames = input.toolNames === undefined
    ? [...DEFAULT_SCHEDULE_TOOLS]
    : Array.isArray(input.toolNames)
      ? [...new Set(input.toolNames)]
      : null;
  if (!toolNames || toolNames.some((tool) => typeof tool !== "string" || !ALLOWED_SCHEDULE_TOOLS.has(tool))) {
    throw new ScheduleValidationError("toolNames contains an unsupported tool");
  }

  const missedRunPolicy = input.missedRunPolicy === undefined ? "run_once" : input.missedRunPolicy;
  if (missedRunPolicy !== "run_once" && missedRunPolicy !== "skip") {
    throw new ScheduleValidationError("Unsupported missed-run policy");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ScheduleValidationError("enabled must be boolean");
  }

  return {
    name,
    cwd,
    prompt,
    timing,
    timezone,
    enabled: input.enabled ?? true,
    missedRunPolicy,
    provider,
    modelId,
    thinkingLevel,
    toolNames: toolNames as string[],
  };
}

export function initialNextRunAt(input: ScheduleInput, now = new Date()): string | null {
  if (input.enabled === false) return null;
  const next = nextScheduleRunAt(input.timing, input.timezone, now);
  if (!next && input.timing.kind === "once") {
    throw new ScheduleValidationError("The one-time schedule must be in the future");
  }
  if (!next) throw new ScheduleValidationError("This schedule has no valid run time in the next 8 years");
  return next;
}
