import { readAgentRunStore } from "@/lib/agent-run-store";
import { isDurableSessionId, readDurableProjection } from "@/lib/durable-session-store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (isDurableSessionId(id)) {
    const projection = readDurableProjection(id);
    return projection?.agentRun ? Response.json({ messages: projection.context.messages, truncated: false, updatedAt: projection.info.modified }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Run not found" }, { status: 404 });
  }
  const run = readAgentRunStore().runs.find(item => item.id === id && item.engine === "durable");
  if (!run) return Response.json({ error: "Durable run not found" }, { status: 404 });
  try {
    // Read only the display projection: never open or resume a Harness on GET.
    const { readDurableTranscript } = await import("@/lib/durable-agent-run");
    return Response.json(readDurableTranscript(id), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Unable to read run transcript" }, { status: 500 });
  }
}
