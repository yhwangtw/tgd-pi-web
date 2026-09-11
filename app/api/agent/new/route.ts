import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { randomUUID } from "node:crypto";
import { startRpcSession } from "@/lib/rpc-manager";
import type { ToolSelectionMode } from "@/lib/tool-selection";

// POST /api/agent/new  body: { cwd: string; type: string; message: string; ... }
// Creates a Pi session. The Web client uses deferPrompt to subscribe before
// the first prompt; legacy callers can still send their first command here.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, toolMode, thinkingLevel, ephemeral, deferPrompt, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; toolMode?: ToolSelectionMode; thinkingLevel?: string; ephemeral?: boolean; deferPrompt?: boolean; [key: string]: unknown };

    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames, { ephemeral: ephemeral === true, toolMode });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    globalThis.__piAllowedRootsCache?.roots.add(cwd);

    // Apply pre-selected model before sending the prompt
    if (provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    const result = deferPrompt === true ? null : await session.send(promptCommand);

    return NextResponse.json({ success: true, sessionId: realSessionId, ephemeral: ephemeral === true, deferred: deferPrompt === true, data: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
