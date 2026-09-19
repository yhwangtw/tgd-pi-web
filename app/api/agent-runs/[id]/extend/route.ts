import { AgentRunConflictError, ensureAgentRunSupervisor } from "@/lib/agent-run-supervisor";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json({ run: ensureAgentRunSupervisor().extend(id) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof AgentRunConflictError ? 409 : 500 });
  }
}
