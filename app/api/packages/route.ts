import { NextResponse } from "next/server";
import { DefaultPackageManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";
import { consumePackageMutation, preparePackageMutation, type PackageMutationAction } from "@/lib/package-confirmation";
import { describeConfiguredPackages, normalizeNpmPackageSource } from "@/lib/package-center";

export const dynamic = "force-dynamic";

class PackageRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin")) {
    throw new PackageRequestError("Package operations require a same-origin browser request", 403);
  }
  if (new URL(origin).host !== new URL(req.url).host) throw new PackageRequestError("Package operation origin mismatch", 403);
}

function managerForSession(sessionId: string) {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) throw new Error("Open an active session before managing packages");
  return {
    session,
    manager: new DefaultPackageManager({
      cwd: session.cwd,
      agentDir: getAgentDir(),
      settingsManager: session.inner.settingsManager,
    }),
  };
}

function snapshot(manager: DefaultPackageManager) {
  return { packages: describeConfiguredPackages(manager) };
}

export async function GET(req: Request) {
  try {
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    const { manager } = managerForSession(sessionId);
    return NextResponse.json(snapshot(manager));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = await req.json() as {
      phase?: unknown;
      action?: unknown;
      source?: unknown;
      sessionId?: unknown;
      confirmationToken?: unknown;
    };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    const { session, manager } = managerForSession(sessionId);

    if (body.action === "check_updates") {
      const updates = await manager.checkForAvailableUpdates();
      return NextResponse.json({ ...snapshot(manager), updates });
    }

    if (body.action !== "install" && body.action !== "remove" && body.action !== "update") {
      return NextResponse.json({ error: "Unknown package action" }, { status: 400 });
    }
    const action = body.action as PackageMutationAction;
    const source = normalizeNpmPackageSource(body.source);
    const configuredPackages = manager.listConfiguredPackages();
    const configured = configuredPackages.find((item) => item.source === source && item.scope === "user");
    const projectConfigured = configuredPackages.some((item) => item.source === source && item.scope === "project");
    if (action !== "install" && !configured) {
      return NextResponse.json({ error: "Only configured user-scope npm packages can be changed" }, { status: 403 });
    }
    if (projectConfigured && action !== "remove") {
      return NextResponse.json({ error: "This package is also configured by the project and is read-only in safe mode" }, { status: 403 });
    }

    if (body.phase === "prepare") {
      const confirmation = preparePackageMutation({ action, source, sessionId });
      return NextResponse.json({ confirmation, action, source });
    }
    if (body.phase !== "execute" || typeof body.confirmationToken !== "string"
      || !consumePackageMutation(body.confirmationToken, { action, source, sessionId })) {
      return NextResponse.json({ error: "Package confirmation expired; review the operation again" }, { status: 409 });
    }

    if (action === "install") await manager.installAndPersist(source);
    else if (action === "remove") await manager.removeAndPersist(source);
    else await manager.update(source);

    let reloadError: string | undefined;
    try {
      await session.reloadExtensions();
    } catch (error) {
      reloadError = error instanceof Error ? error.message : String(error);
    }
    return NextResponse.json({ ...snapshot(manager), reloadError });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof PackageRequestError ? error.status : 500 },
    );
  }
}
