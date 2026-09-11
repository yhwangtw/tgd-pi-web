import { NextResponse } from "next/server";
import { DefaultPackageManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";
import { consumePreparedPackageMutation, preparePackageMutation, type PackageMutationAction } from "@/lib/package-confirmation";
import {
  buildPackageMutationPreview,
  describeConfiguredPackages,
  inspectNpmPackageSource,
  isPinnedPackageSource,
  normalizeNpmPackageSource,
} from "@/lib/package-center";
import { redactedErrorMessage } from "@/lib/redaction";
import { recordSecurityActivity, type SecurityActivityOutcome } from "@/lib/security-activity";
import { requestHasExplicitSameOrigin } from "@/lib/request-origin";

export const dynamic = "force-dynamic";

class PackageRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function assertSameOrigin(req: Request): void {
  if (!requestHasExplicitSameOrigin(req)) {
    throw new PackageRequestError("Package operations require a same-origin browser request", 403);
  }
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
    return NextResponse.json({ error: redactedErrorMessage(error) }, { status: 409 });
  }
}

export async function POST(req: Request) {
  let activity: { action: string; source?: string; sessionId?: string } | null = null;
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
    activity = { action, source, sessionId };
    const audit = (outcome: SecurityActivityOutcome, summary: string, details?: Record<string, unknown>) => {
      recordSecurityActivity({
        category: "package",
        action,
        outcome,
        summary,
        target: source,
        sessionId,
        details,
      });
    };
    const deny = (message: string, status: number) => {
      audit("denied", message);
      return NextResponse.json({ error: message }, { status });
    };
    const configuredPackages = manager.listConfiguredPackages();
    const configured = configuredPackages.find((item) => item.source === source && item.scope === "user");
    const projectConfigured = configuredPackages.some((item) => item.source === source && item.scope === "project");
    if (action !== "install" && !configured) {
      return deny("Only configured user-scope npm packages can be changed", 403);
    }
    if (projectConfigured && action !== "remove") {
      return deny("This package is also configured by the project and is read-only in safe mode", 403);
    }
    if (action === "update" && isPinnedPackageSource(source)) {
      return deny("Pinned package versions cannot be updated; install a reviewed version explicitly", 403);
    }

    if (body.phase === "prepare") {
      const current = configured ? describeConfiguredPackages(manager)
        .find((item) => item.source === source && item.scope === "user")?.inspection : undefined;
      const target = action === "remove" ? undefined : await inspectNpmPackageSource(source);
      if (target && (!target.hasPiManifest || target.resources.length === 0)) {
        return deny("Safe mode requires an explicit Pi package manifest with declared resources", 422);
      }
      const preview = buildPackageMutationPreview(action, source, current, target);
      const confirmation = preparePackageMutation({
        action,
        source,
        sessionId,
        resolvedSource: target?.resolvedSource,
        integrity: target?.integrity,
      });
      audit("reviewed", `Package ${action} reviewed`, {
        currentVersion: current?.version,
        targetVersion: target?.version,
        addedPermissions: preview.addedPermissions,
        integrity: target?.integrity,
      });
      return NextResponse.json({ confirmation, action, source, preview });
    }
    const prepared = body.phase === "execute" && typeof body.confirmationToken === "string"
      ? consumePreparedPackageMutation(body.confirmationToken, { action, source, sessionId })
      : null;
    if (!prepared) {
      return deny("Package confirmation expired; review the operation again", 409);
    }

    if (action === "install" || action === "update") {
      const verified = await inspectNpmPackageSource(source);
      if (
        verified.resolvedSource !== prepared.resolvedSource
        || (prepared.integrity && verified.integrity !== prepared.integrity)
      ) {
        return deny("Package metadata changed after review; review the operation again", 409);
      }
      await manager.install(prepared.resolvedSource ?? source);
      if (action === "install") manager.addSourceToSettings(source);
    } else {
      await manager.removeAndPersist(source);
    }

    let reloadError: string | undefined;
    try {
      await session.reloadExtensions();
    } catch (error) {
      reloadError = error instanceof Error ? error.message : String(error);
    }
    audit("success", `Package ${action} completed`, {
      resolvedSource: prepared.resolvedSource,
      integrity: prepared.integrity,
      reloadError,
    });
    return NextResponse.json({ ...snapshot(manager), reloadError });
  } catch (error) {
    recordSecurityActivity({
      category: "package",
      action: activity?.action ?? "request",
      outcome: "failure",
      summary: redactedErrorMessage(error),
      target: activity?.source,
      sessionId: activity?.sessionId,
    });
    return NextResponse.json(
      { error: redactedErrorMessage(error) },
      { status: error instanceof PackageRequestError ? error.status : 500 },
    );
  }
}
