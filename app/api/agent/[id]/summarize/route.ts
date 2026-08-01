import { NextResponse } from "next/server";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

interface PiMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    let session = getRpcSession(id);
    if (!session?.isAlive()) {
      const { resolveSessionPath } = await import("@/lib/session-reader");
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
      const result = await startRpcSession(id, filePath, cwd);
      session = result.session;
    }

    const inner = session.inner;

    // Don't rename if already named
    const existingName = inner.sessionManager.getSessionName?.();
    if (existingName) {
      return NextResponse.json({ name: existingName, skipped: true });
    }

    const modelLike = inner.model;
    if (!modelLike) {
      return NextResponse.json({ error: "No model configured" }, { status: 400 });
    }

    // Get the full Model<Api> object from model registry (has api, baseUrl, etc.)
    const fullModel = session.modelRegistry?.find(modelLike.provider, modelLike.id);
    if (!fullModel) {
      return NextResponse.json({ error: "Model not found in registry" }, { status: 400 });
    }

    // Extract first user + assistant exchange
    const messages: PiMessage[] = (inner.agent as { state?: { messages?: PiMessage[] } })?.state?.messages ?? [];
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (!firstUser || !firstAssistant) {
      return NextResponse.json({ error: "No conversation to summarize" }, { status: 400 });
    }

    const extractText = (content: string | Array<{ type: string; text?: string }>): string =>
      typeof content === "string"
        ? content
        : (content || []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");

    const truncatedUser = extractText(firstUser.content).slice(0, 500);
    const truncatedAssistant = extractText(firstAssistant.content).slice(0, 500);

    // Use Pi's own streamFn (already bound with model, apiKey, headers, retry)
    const agent = inner.agent as { streamFn?: (...args: unknown[]) => Promise<{ result: () => Promise<{ content?: Array<{ type: string; text?: string }> }> }> };
    const streamFn = agent.streamFn;
    if (!streamFn) {
      return NextResponse.json({ error: "streamFn not available" }, { status: 500 });
    }

    const titlePrompt = `Based on the following conversation, generate a concise title (max 10 words, in the same language as the conversation). Output ONLY the title text, nothing else.\n\nUser: ${truncatedUser}\nAssistant: ${truncatedAssistant}`;

    // streamFn is async and returns AssistantMessageEventStream (has .result())
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let eventStream: Awaited<ReturnType<typeof streamFn>>;
    try {
      eventStream = await streamFn(fullModel, {
        systemPrompt: "You are a title generator. Output only a short title. No quotes, no explanations.",
        messages: [{
          role: "user",
          content: titlePrompt,
          timestamp: Date.now(),
        }],
      }, { maxTokens: 30 });
    } finally {
      clearTimeout(timeout);
    }

    const result = await eventStream.result();

    const rawTitle = (result.content || [])
      .filter((c: { type: string; text?: string }) => c.type === "text")
      .map((c: { type: string; text?: string }) => c.text ?? "")
      .join("")
      .trim()
      .replace(/^["']|["']$/g, "")
      .slice(0, 80);

    if (!rawTitle) {
      return NextResponse.json({ error: "Empty title" }, { status: 500 });
    }

    // Use the correct SDK method: appendSessionInfo writes a session_info entry
    inner.sessionManager.appendSessionInfo(rawTitle);

    return NextResponse.json({ name: rawTitle });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json({ error: "Title generation timed out" }, { status: 504 });
    }
    console.error("Summarize error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
