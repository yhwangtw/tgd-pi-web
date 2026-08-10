import { NextResponse } from "next/server";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { buildExtensionsReport, collectExtensionResources } from "@/lib/extensions-info";

export const dynamic = "force-dynamic";

// Get (or revive from file) the in-process agent session — same pattern as
// the command route: extensions live on the session's ExtensionRunner.
async function ensureSession(id: string): Promise<AgentSessionWrapper | null> {
  const existing = getRpcSession(id);
  if (existing?.isAlive()) return existing;
  const { resolveSessionPath } = await import("@/lib/session-reader");
  const filePath = await resolveSessionPath(id);
  if (!filePath) return null;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  const { session } = await startRpcSession(id, filePath, cwd);
  return session;
}

// GET /api/agent/[id]/extensions — what the session's extensions registered
// (commands / tools / flags) plus the load diagnostics.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const session = await ensureSession(id);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const runner = session.inner.extensionRunner;
    if (!runner) return NextResponse.json({ error: "Extensions not loaded" }, { status: 500 });
    const loader = session.inner.resourceLoader;
    const loadResult = loader?.getExtensions();
    return NextResponse.json(buildExtensionsReport(runner, {
      loadResult,
      providers: session.getExtensionProviders(),
      resources: loader ? collectExtensionResources(loader) : [],
      runtimeDiagnostics: session.getExtensionDiagnostics(),
      runtime: session.getRuntimeDiagnostics(),
    }));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/agent/[id]/extensions
//   { action: "set_flag", name, value }  — flip an extension CLI flag live
//   { action: "reload" }                 — use Pi's native reload lifecycle to
//                                          re-discover extensions, skills,
//                                          prompts, and provider models
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { action?: string; name?: string; value?: boolean | string; shortcut?: string };

    if (body.action === "run_shortcut") {
      if (!body.shortcut) return NextResponse.json({ error: "shortcut is required" }, { status: 400 });
      const session = await ensureSession(id);
      if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      const runner = session.inner.extensionRunner;
      const extensions = session.inner.resourceLoader?.getExtensions().extensions ?? [];
      if (!runner) return NextResponse.json({ error: "Extensions not loaded" }, { status: 500 });
      const registration = extensions.flatMap((extension) => [...extension.shortcuts.values()]).find((shortcut) => shortcut.shortcut === body.shortcut);
      if (!registration) return NextResponse.json({ error: "Shortcut not found" }, { status: 404 });
      await registration.handler(runner.createContext());
      return NextResponse.json({ ok: true, shortcut: body.shortcut });
    }

    if (body.action === "set_flag") {
      if (!body.name || body.value === undefined) {
        return NextResponse.json({ error: "name and value are required" }, { status: 400 });
      }
      const session = await ensureSession(id);
      if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      const runner = session.inner.extensionRunner;
      if (!runner) return NextResponse.json({ error: "Extensions not loaded" }, { status: 500 });
      runner.setFlagValue(body.name, body.value);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "reload") {
      const session = await ensureSession(id);
      if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      // Pi emits session_shutdown(reload), reloads all resources/providers,
      // rebuilds the extension runtime, then emits session_start(reload) and
      // resources_discover while preserving this wrapper's SSE listeners.
      await session.reloadExtensions();
      return NextResponse.json({ ok: true, reloaded: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
