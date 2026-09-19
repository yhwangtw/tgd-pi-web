import { ensureAgentRunSupervisor } from "@/lib/agent-run-supervisor";
import { readAgentRunStore } from "@/lib/agent-run-store";
import type { AgentRunStatus } from "@/lib/agent-run-types";
import {
  AgentRunValidationError,
  validateAgentRunConfigInput,
  validateAgentRunInput,
} from "@/lib/agent-run-validation";
import {
  inspectAgentRunWorkspace,
  isTrustedAgentRunWorkspace,
} from "@/lib/agent-run-workspace";

export const dynamic = "force-dynamic";

const STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function requiresJson(req: Request): Response | null {
  return req.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ? null
    : Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
}

function decodeCursor(cursor: string | null): number | null {
  if (!cursor) return 0;
  try {
    const parsed = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export async function GET(req: Request): Promise<Response> {
  const supervisor = ensureAgentRunSupervisor();
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  if (statusParam && !STATUSES.has(statusParam as AgentRunStatus)) {
    return Response.json({ error: "Unsupported status" }, { status: 400 });
  }
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return Response.json({ error: "limit must be between 1 and 200" }, { status: 400 });
  }
  const offset = decodeCursor(url.searchParams.get("cursor"));
  if (offset === null) return Response.json({ error: "Invalid cursor" }, { status: 400 });

  const cwd = url.searchParams.get("cwd");
  const query = url.searchParams.get("q")?.trim().toLocaleLowerCase() ?? "";
  const baseRuns = readAgentRunStore().runs.filter((run) => {
    if (cwd && run.cwd !== cwd) return false;
    if (!query) return true;
    return `${run.name}\n${run.cwd}\n${run.prompt}`.toLocaleLowerCase().includes(query);
  });
  const counts = Object.fromEntries(
    [...STATUSES].map((status) => [status, baseRuns.filter((run) => run.status === status).length]),
  ) as Record<AgentRunStatus, number>;
  const filtered = statusParam
    ? baseRuns.filter((run) => run.status === statusParam)
    : baseRuns;
  const runs = filtered.slice(offset, offset + limit);
  const nextOffset = offset + runs.length;

  return Response.json({
    runs,
    counts,
    maxConcurrency: supervisor.maxConcurrency,
    subagentLimits: readAgentRunStore().subagentLimits,
    serverTime: new Date().toISOString(),
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset) : null,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const invalidType = requiresJson(req);
  if (invalidType) return invalidType;
  try {
    const input = await validateAgentRunInput(await req.json());
    if (!await isTrustedAgentRunWorkspace(input.cwd)) {
      return Response.json({
        error: "Workspace is not trusted. Open it as a project before starting a background agent.",
      }, { status: 403 });
    }
    const workspace = await inspectAgentRunWorkspace(input.cwd);
    const run = ensureAgentRunSupervisor().enqueue({ ...input, workspace });
    return Response.json({ run }, { status: 202 });
  } catch (error) {
    const status = error instanceof AgentRunValidationError || error instanceof SyntaxError ? 400 : 500;
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const invalidType = requiresJson(req);
  if (invalidType) return invalidType;
  try {
    const { maxConcurrency, subagentLimits } = validateAgentRunConfigInput(await req.json());
    const applied = ensureAgentRunSupervisor().setMaxConcurrency(maxConcurrency);
    if (subagentLimits !== undefined) ensureAgentRunSupervisor().setSubagentLimits(subagentLimits);
    return Response.json({ maxConcurrency: applied }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof AgentRunValidationError
      || error instanceof SyntaxError
      || error instanceof RangeError
      ? 400
      : 500;
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status });
  }
}
