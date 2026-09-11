import { NextResponse } from "next/server";
import { redactedErrorMessage } from "@/lib/redaction";
import { recordSecurityActivity } from "@/lib/security-activity";
import { requestHasExplicitSameOrigin } from "@/lib/request-origin";
import {
  consumeSensitiveAction,
  prepareSensitiveAction,
  type SensitiveActionKind,
} from "@/lib/sensitive-action-confirmation";
import {
  beginManagedUpdateOperation,
  createUpdateBackup,
  executeManagedUpdateAction,
  failReservedUpdateOperation,
  findUpdateBackup,
  getUpdateCenterStatus,
  updateActionFingerprint,
  validateUpdateAction,
  type UpdateCenterAction,
} from "@/lib/update-center";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<UpdateCenterAction>(["backup", "update", "restart", "rollback"]);
const KINDS: Record<UpdateCenterAction, SensitiveActionKind> = {
  backup: "update_backup",
  update: "update_apply",
  restart: "update_restart",
  rollback: "update_rollback",
};

interface MutationBody {
  phase?: "prepare" | "execute";
  action?: UpdateCenterAction;
  token?: string;
  backupId?: string;
}

class UpdateRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UpdateRequestError";
  }
}

function assertSameOrigin(req: Request): void {
  if (!requestHasExplicitSameOrigin(req)) {
    throw new UpdateRequestError("Update actions require a same-origin browser request", 403);
  }
}

function actionSummary(action: UpdateCenterAction): string {
  switch (action) {
    case "backup": return "Create a private source recovery backup";
    case "update": return "Prepare and start the managed application update";
    case "restart": return "Start the managed application restart";
    case "rollback": return "Start the managed application rollback";
  }
}

function actionImpact(action: UpdateCenterAction): string[] {
  switch (action) {
    case "backup":
      return ["backup_copy", "no_runtime_change"];
    case "update":
      return ["automatic_backup", "source_replace", "pi_data_preserved"];
    case "restart":
      return ["temporary_disconnect", "runs_interrupted"];
    case "rollback":
      return ["selected_backup", "source_replace", "review_backup"];
  }
}

export async function GET(req: Request) {
  try {
    const forceReleaseRefresh = new URL(req.url).searchParams.get("refresh") === "1";
    return NextResponse.json(await getUpdateCenterStatus({ forceReleaseRefresh }));
  } catch (error) {
    return NextResponse.json(
      { error: redactedErrorMessage(error) },
      { status: error instanceof UpdateRequestError ? error.status : 500 },
    );
  }
}

export async function POST(req: Request) {
  let action: UpdateCenterAction | undefined;
  let operationId: string | undefined;
  try {
    assertSameOrigin(req);
    const body = await req.json() as MutationBody;
    action = body.action;
    if (!action || !ACTIONS.has(action)) {
      return NextResponse.json({ error: "Unknown update action" }, { status: 400 });
    }
    if (body.phase !== "prepare" && body.phase !== "execute") {
      return NextResponse.json({ error: "Update action phase must be prepare or execute" }, { status: 400 });
    }

    const status = await getUpdateCenterStatus();
    let selectedBackup = body.backupId
      ? await findUpdateBackup(status.backup.root, body.backupId)
      : null;
    if (action === "rollback" && body.backupId && !selectedBackup) {
      return NextResponse.json({ error: "Selected recovery backup was not found" }, { status: 404 });
    }
    const validationError = validateUpdateAction(status, action, body.backupId);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 409 });

    const fingerprint = updateActionFingerprint(status, action, body.backupId);
    if (body.phase === "prepare") {
      const prepared = prepareSensitiveAction(KINDS[action], fingerprint);
      recordSecurityActivity({
        category: "update",
        action: `prepare_${action}`,
        outcome: "reviewed",
        summary: actionSummary(action),
        target: action === "rollback" ? selectedBackup?.id : status.latest.tag,
        details: {
          currentVersion: status.current.version,
          targetVersion: status.latest.version,
          backupId: selectedBackup?.id,
        },
      });
      return NextResponse.json({
        confirmation: {
          token: prepared.token,
          expiresAt: prepared.expiresAt,
          action,
          summary: actionSummary(action),
          impact: actionImpact(action),
          currentVersion: status.current.version,
          targetVersion: status.latest.version,
          backup: selectedBackup,
        },
      });
    }

    if (!body.token || !consumeSensitiveAction(body.token, KINDS[action], fingerprint)) {
      recordSecurityActivity({
        category: "update",
        action,
        outcome: "denied",
        summary: "Update action confirmation expired or no longer matched the current source state",
        target: body.backupId ?? status.latest.tag,
      });
      return NextResponse.json({ error: "The confirmation expired or the source changed. Review the action again." }, { status: 409 });
    }

    if (action === "backup") {
      const backup = await createUpdateBackup({ backupRoot: status.backup.root, version: status.current.version });
      recordSecurityActivity({
        category: "update",
        action,
        outcome: "success",
        summary: "Private source recovery backup created",
        target: backup.id,
        details: { version: backup.version, source: backup.source, dirty: backup.dirty, untrackedFiles: backup.untrackedFiles },
      });
      return NextResponse.json({ ok: true, action, backup, status: await getUpdateCenterStatus() });
    }

    // Reserve before the automatic source backup too: another tab must not
    // replace source while this operation is still capturing its recovery copy.
    const operation = await beginManagedUpdateOperation(action, {
      targetTag: status.latest.tag, backup: selectedBackup ?? undefined,
    });
    operationId = operation.id;
    if (action === "update") {
      selectedBackup = await createUpdateBackup({ backupRoot: status.backup.root, version: status.current.version });
    }
    const started = await executeManagedUpdateAction(action, {
      targetTag: status.latest.tag,
      backup: selectedBackup ?? undefined,
      operationId,
    });
    recordSecurityActivity({
      category: "update",
      action,
      outcome: "success",
      summary: `${actionSummary(action)} command started`,
      target: action === "rollback" ? selectedBackup?.id : status.latest.tag,
      details: { command: started.label, pid: started.pid, backupId: selectedBackup?.id },
    });
    return NextResponse.json({
      ok: true,
      action,
      started,
      operationId,
      backup: selectedBackup,
      message: action === "restart" ? "Restart started; this page may disconnect." : `${action} started`,
    });
  } catch (error) {
    if (operationId) await failReservedUpdateOperation(operationId).catch(() => {});
    if (action) {
      recordSecurityActivity({
        category: "update",
        action,
        outcome: "failure",
        summary: `Update Center could not complete ${action}`,
        details: { error: redactedErrorMessage(error) },
      });
    }
    return NextResponse.json(
      { error: redactedErrorMessage(error) },
      { status: error instanceof UpdateRequestError ? error.status : (error as { code?: string })?.code === "UPDATE_OPERATION_CONFLICT" ? 409 : 500 },
    );
  }
}
