import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import { listAllSessions } from "@/lib/session-reader";
import { consumeSensitiveAction, prepareSensitiveAction } from "@/lib/sensitive-action-confirmation";
import { resolveSkillInstallTarget, SkillInstallValidationError } from "@/lib/skill-install";
import { redactedErrorMessage, redactSensitiveText } from "@/lib/redaction";
import { recordSecurityActivity } from "@/lib/security-activity";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin") || new URL(origin).host !== new URL(req.url).host) {
    throw new SkillInstallValidationError("Skill installation requires a same-origin browser request", 403);
  }
}

// POST /api/skills/install
// body: { phase: "prepare" | "execute"; package: string;
//         scope: "global" | "project"; cwd?: string; confirmationToken?: string }
export async function POST(req: Request) {
  let activity: { source?: string; scope?: string; cwd?: string } | null = null;
  try {
    assertSameOrigin(req);
    const body = await req.json() as {
      phase?: unknown;
      package?: unknown;
      scope?: unknown;
      cwd?: unknown;
      confirmationToken?: unknown;
    };
    const sessions = await listAllSessions();
    const target = resolveSkillInstallTarget(
      { source: body.package, scope: body.scope, cwd: body.cwd },
      sessions.map((session) => session.cwd).filter((cwd): cwd is string => Boolean(cwd)),
    );
    activity = { source: target.source, scope: target.scope, cwd: target.cwd };

    if (body.phase === "prepare") {
      recordSecurityActivity({
        category: "skill",
        action: "install",
        outcome: "reviewed",
        summary: "Skill installation reviewed",
        target: target.source,
        cwd: target.cwd,
        details: { scope: target.scope, installPath: target.installPath },
      });
      return NextResponse.json({
        confirmation: prepareSensitiveAction("skill_install", target.fingerprint),
        review: {
          source: target.source,
          scope: target.scope,
          cwd: target.cwd ?? null,
          installPath: target.installPath,
        },
      });
    }
    if (body.phase !== "execute"
      || typeof body.confirmationToken !== "string"
      || !consumeSensitiveAction(body.confirmationToken, "skill_install", target.fingerprint)) {
      recordSecurityActivity({
        category: "skill",
        action: "install",
        outcome: "denied",
        summary: "Skill installation confirmation expired",
        target: target.source,
        cwd: target.cwd,
        details: { scope: target.scope },
      });
      return NextResponse.json(
        { error: "Skill installation confirmation expired; review the operation again" },
        { status: 409 },
      );
    }

    const args = ["skills", "add", target.source, "-y", "--agent", "pi"];
    if (target.scope === "global") args.push("-g");
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: target.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = redactSensitiveText((stdout + stderr).replace(ANSI_RE, ""));
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      recordSecurityActivity({
        category: "skill",
        action: "install",
        outcome: "failure",
        summary: output.slice(-300) || "Skill installation failed",
        target: target.source,
        cwd: target.cwd,
        details: { scope: target.scope },
      });
      return NextResponse.json({ error: output.slice(-300) || "Install failed" }, { status: 500 });
    }
    recordSecurityActivity({
      category: "skill",
      action: "install",
      outcome: "success",
      summary: "Skill installation completed",
      target: target.source,
      cwd: target.cwd,
      details: { scope: target.scope, installPath: target.installPath },
    });
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = redactSensitiveText(((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, ""));
    recordSecurityActivity({
      category: "skill",
      action: "install",
      outcome: "failure",
      summary: output || redactedErrorMessage(e),
      target: activity?.source,
      cwd: activity?.cwd,
      details: activity?.scope ? { scope: activity.scope } : undefined,
    });
    return NextResponse.json(
      { error: output || redactedErrorMessage(err.message ?? e) },
      { status: e instanceof SkillInstallValidationError ? e.status : 500 },
    );
  }
}
