import {
  AgentRunNotFoundError,
  ensureAgentRunSupervisor,
} from "@/lib/agent-run-supervisor";

export const dynamic = "force-dynamic";
import { isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";
import { openDurableChat } from "@/lib/durable-chat";

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
    if (isDurableSessionId(id)) {
      if (!readDurableProjection(id)?.agentRun) return Response.json({ error: "Run not found" }, { status: 404 });
      const chat = await openDurableChat(id); await chat.send({ type: "abort" });
      return Response.json({ run: chat.getProjection().agentRun });
    }
    const run = await ensureAgentRunSupervisor().cancel(id);
    return Response.json({ run });
  } catch (error) {
    const status = error instanceof AgentRunNotFoundError
      ? 404
      : error instanceof SyntaxError ? 400 : 500;
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status });
  }
}
