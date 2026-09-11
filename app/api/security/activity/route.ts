import { NextResponse } from "next/server";
import { redactedErrorMessage } from "@/lib/redaction";
import { requestHasExplicitSameOrigin } from "@/lib/request-origin";
import {
  clearSecurityActivity,
  readSecurityActivityStore,
  recordSecurityActivity,
  SECURITY_ACTIVITY_RETENTION_DAYS,
  type SecurityActivityCategory,
  type SecurityActivityOutcome,
} from "@/lib/security-activity";

export const dynamic = "force-dynamic";

const CATEGORIES = new Set<SecurityActivityCategory>(["package", "mcp", "skill", "snapshot", "extension", "update", "security"]);
const OUTCOMES = new Set<SecurityActivityOutcome>(["reviewed", "success", "denied", "failure"]);

function assertSameOrigin(req: Request): void {
  if (!requestHasExplicitSameOrigin(req)) {
    throw new Error("Security activity changes require a same-origin browser request");
  }
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const category = params.get("category") as SecurityActivityCategory | null;
    const outcome = params.get("outcome") as SecurityActivityOutcome | null;
    const query = params.get("q")?.trim().toLocaleLowerCase() ?? "";
    const requestedLimit = Number(params.get("limit") ?? 250);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1_000, Math.floor(requestedLimit))) : 250;
    let entries = readSecurityActivityStore().entries;
    if (category && CATEGORIES.has(category)) entries = entries.filter((entry) => entry.category === category);
    if (outcome && OUTCOMES.has(outcome)) entries = entries.filter((entry) => entry.outcome === outcome);
    if (query) {
      entries = entries.filter((entry) => [entry.summary, entry.target, entry.action, entry.cwd]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(query)));
    }
    return NextResponse.json({
      entries: entries.slice(0, limit),
      total: entries.length,
      retentionDays: SECURITY_ACTIVITY_RETENTION_DAYS,
    });
  } catch (error) {
    return NextResponse.json({ error: redactedErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    assertSameOrigin(req);
    const cleared = clearSecurityActivity();
    recordSecurityActivity({
      category: "security",
      action: "clear_activity",
      outcome: "success",
      summary: "Security activity was cleared",
      details: { cleared },
    });
    return NextResponse.json({ ok: true, cleared });
  } catch (error) {
    return NextResponse.json({ error: redactedErrorMessage(error) }, { status: 403 });
  }
}
