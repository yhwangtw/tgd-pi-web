import { cancelUpstreamAgentRun, isUpstreamAgentRunId, UpstreamAgentRunError } from "@/lib/upstream-subagent-runs";
import {
  AgentRunNotFoundError,
  ensureAgentRunSupervisor,
} from "@/lib/agent-run-supervisor";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "JSON object is required" }, { status: 400 });
    }
    const { id } = await params;
    if (isUpstreamAgentRunId(id)) {
      const run = await cancelUpstreamAgentRun(id);
      return Response.json({ run }, { status: 202 });
    }
    const run = await ensureAgentRunSupervisor().cancel(id);
    return Response.json({ run });
  } catch (error) {
    const status = error instanceof UpstreamAgentRunError
      ? error.status
      : error instanceof AgentRunNotFoundError
      ? 404
      : error instanceof SyntaxError ? 400 : 500;
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status });
  }
}
