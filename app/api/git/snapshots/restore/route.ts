import { NextResponse } from "next/server";
import { getAllowedRoots } from "@/lib/file-security";
import { inspectSnapshotRestore, restoreSnapshot } from "@/lib/git-snapshot";
import { redactedErrorMessage } from "@/lib/redaction";
import { recordSecurityActivity } from "@/lib/security-activity";
import { consumeSensitiveAction, prepareSensitiveAction } from "@/lib/sensitive-action-confirmation";

export const dynamic = "force-dynamic";

class SnapshotRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin") || new URL(origin).host !== new URL(req.url).host) {
    throw new SnapshotRequestError("Restore requires a same-origin browser request", 403);
  }
}

// POST /api/git/snapshots/restore  body: { cwd, sessionId, id }
// Reverts the working tree to the snapshot, touching only the changed files.
export async function POST(req: Request) {
  let activity: { cwd?: string; sessionId?: string; id?: string } | null = null;
  try {
    assertSameOrigin(req);
    const body = await req.json() as {
      phase?: "prepare" | "execute";
      cwd?: string;
      sessionId?: string;
      id?: string;
      confirmationToken?: string;
    };
    const { cwd, sessionId, id } = body;
    activity = { cwd, sessionId, id };
    if (!cwd || !sessionId || !id) {
      throw new SnapshotRequestError("cwd, sessionId and id required", 400);
    }
    const roots = await getAllowedRoots();
    if (!roots.has(cwd)) {
      recordSecurityActivity({
        category: "snapshot",
        action: "restore",
        outcome: "denied",
        summary: "Restore working directory is not allowed",
        target: id,
        sessionId,
        cwd,
      });
      return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
    }
    const review = await inspectSnapshotRestore(cwd, sessionId, id);
    if (body.phase === "prepare") {
      recordSecurityActivity({
        category: "snapshot",
        action: "restore",
        outcome: "reviewed",
        summary: "Restore point reviewed",
        target: review.label,
        sessionId,
        cwd,
        details: { snapshotId: id, impact: review.impact },
      });
      return NextResponse.json({
        confirmation: prepareSensitiveAction("snapshot_restore", review.fingerprint),
        review: { label: review.label, impact: review.impact },
      });
    }
    if (body.phase !== "execute"
      || typeof body.confirmationToken !== "string"
      || !consumeSensitiveAction(body.confirmationToken, "snapshot_restore", review.fingerprint)) {
      recordSecurityActivity({
        category: "snapshot",
        action: "restore",
        outcome: "denied",
        summary: "Restore confirmation expired or the working tree changed",
        target: review.label,
        sessionId,
        cwd,
        details: { snapshotId: id },
      });
      return NextResponse.json(
        { error: "Restore changed after review; review it again" },
        { status: 409 },
      );
    }
    const result = await restoreSnapshot(cwd, sessionId, id, review.currentTree);
    recordSecurityActivity({
      category: "snapshot",
      action: "restore",
      outcome: "success",
      summary: "Restore point applied",
      target: review.label,
      sessionId,
      cwd,
      details: { snapshotId: id, ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    recordSecurityActivity({
      category: "snapshot",
      action: "restore",
      outcome: "failure",
      summary: redactedErrorMessage(error),
      target: activity?.id,
      sessionId: activity?.sessionId,
      cwd: activity?.cwd,
    });
    return NextResponse.json(
      { error: redactedErrorMessage(error) },
      { status: error instanceof SnapshotRequestError ? error.status : 500 },
    );
  }
}
