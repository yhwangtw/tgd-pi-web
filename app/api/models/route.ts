import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { getRpcSession } from "@/lib/rpc-manager";
import { createTrackedAgentServices } from "@/lib/pi-runtime";
import {
  buildModelCatalog,
  resolveModelCatalogCwd,
  resolveModelCatalogSource,
  type ModelCatalogSource,
} from "@/lib/model-catalog";

export const dynamic = "force-dynamic";

async function activeSessionSource(sessionId: string): Promise<ModelCatalogSource | null> {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive() || !session.modelRegistry) return null;
  await session.refreshModels();
  return {
    registry: session.modelRegistry,
    settings: session.inner.settingsManager,
    diagnostics: session.getExtensionDiagnostics(),
  };
}

async function cwdSource(cwd: string): Promise<ModelCatalogSource> {
  const { services, modelRegistry } = await createTrackedAgentServices(cwd);
  return {
    registry: modelRegistry,
    settings: services.settingsManager,
    diagnostics: services.diagnostics,
  };
}

async function validateCwd(cwd: string): Promise<Response | null> {
  if (!isAbsolute(cwd)) {
    return Response.json({ error: "cwd must be absolute" }, { status: 400 });
  }
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return Response.json({ error: "cwd must be a directory" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "cwd does not exist" }, { status: 400 });
  }
  return null;
}

async function catalogResponse(sessionId: string | null, cwd: string): Promise<Response> {
  const invalid = await validateCwd(cwd);
  if (invalid) return invalid;
  try {
    const source = await resolveModelCatalogSource({
      sessionId,
      cwd,
      getSessionSource: activeSessionSource,
      createCwdSource: cwdSource,
    });
    return Response.json(buildModelCatalog(source.registry, source.settings, source.diagnostics));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

async function storedSessionCwd(sessionId: string): Promise<string | null> {
  const active = getRpcSession(sessionId);
  if (active?.isAlive()) return active.cwd;
  const { readSessionCwd, resolveSessionPath } = await import("@/lib/session-reader");
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  return readSessionCwd(filePath);
}

// GET /api/models?sessionId=
// GET never trusts a caller-supplied cwd because extension discovery executes
// project code. It uses only the active/session-file cwd.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  const sessionCwd = await storedSessionCwd(sessionId);
  if (!sessionCwd) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  const cwd = resolveModelCatalogCwd({
    method: "GET",
    requestedCwd: url.searchParams.get("cwd"),
    sessionCwd,
  });
  if (!cwd) return Response.json({ error: "Session cwd is missing" }, { status: 400 });
  return catalogResponse(sessionId, cwd);
}

// POST /api/models { cwd }
// New-workspace discovery is an explicit JSON POST so a cross-origin GET
// cannot make the local server execute an arbitrary project's extensions.
export async function POST(req: Request) {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { cwd?: unknown };
  try {
    body = await req.json() as { cwd?: unknown };
  } catch {
    return Response.json({ error: "JSON body is required" }, { status: 400 });
  }
  if (typeof body.cwd !== "string") {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }
  const cwd = resolveModelCatalogCwd({
    method: "POST",
    requestedCwd: body.cwd,
    sessionCwd: null,
  });
  if (!cwd) return Response.json({ error: "cwd is required" }, { status: 400 });
  return catalogResponse(null, cwd);
}
