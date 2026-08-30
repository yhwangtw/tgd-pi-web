import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSensitiveActionConfirmationsForTests } from "../sensitive-action-confirmation";

const mocks = vi.hoisted(() => {
  const backup = {
    id: "source-20260831T000000Z-deadbeef",
    createdAt: "2026-08-31T00:00:00.000Z",
    path: "/private/backups/source-20260831T000000Z-deadbeef",
    source: "git" as const,
    version: "2026.08.27-1",
    head: "abc1234",
    branch: "main",
    dirty: true,
    untrackedFiles: 1,
  };
  const status = {
    checkedAt: "2026-08-31T00:00:00.000Z",
    current: {
      version: "2026.08.27-1",
      source: "git" as const,
      head: "abc1234",
      branch: "main",
      dirty: true,
      changedFiles: 2,
      untrackedFiles: 1,
      sourceFingerprint: "source-a",
    },
    latest: {
      version: "2026.08.31",
      tag: "v2026.08.31",
      url: "https://example.invalid/releases/v2026.08.31",
    },
    updateAvailable: true,
    preflight: { ready: true, checks: [] },
    backup: { root: "/private/backups", writable: true, latest: backup, recent: [backup] },
    actions: {
      backup: { configured: true, ready: true },
      update: { configured: true, ready: true },
      restart: { configured: true, ready: true },
      rollback: { configured: true, ready: true },
    },
    dataImpact: { preservesAgentData: true as const, sourceMayChange: true as const, requiresRestart: true as const },
    commands: { update: "bash setup.sh", restart: "npm start", rollback: "restore" },
  };
  return {
    backup,
    status,
    createUpdateBackup: vi.fn(async () => backup),
    executeManagedUpdateAction: vi.fn(async () => ({ pid: 42, label: "pi-web-update" })),
    recordSecurityActivity: vi.fn(),
  };
});

vi.mock("@/lib/security-activity", () => ({ recordSecurityActivity: mocks.recordSecurityActivity }));
vi.mock("@/lib/update-center", () => ({
  createUpdateBackup: mocks.createUpdateBackup,
  executeManagedUpdateAction: mocks.executeManagedUpdateAction,
  findUpdateBackup: vi.fn(async (_root: string, id: string) => id === mocks.backup.id ? mocks.backup : null),
  getUpdateCenterStatus: vi.fn(async () => mocks.status),
  updateActionFingerprint: vi.fn((status: typeof mocks.status, action: string, backupId?: string) => (
    `${action}:${backupId ?? ""}:${status.current.sourceFingerprint}:${status.latest.tag}`
  )),
  validateUpdateAction: vi.fn((status: typeof mocks.status, action: string, backupId?: string) => {
    if (action === "backup") return status.actions.backup.ready ? null : "Private backup is unavailable";
    const managed = status.actions[action as "update" | "restart" | "rollback"];
    if (!managed.ready) return `Managed ${action} action is not configured`;
    if (action === "update" && status.updateAvailable !== true) return "No newer release is available";
    if (action === "rollback" && !backupId) return "Choose a recovery backup before rollback";
    return null;
  }),
}));

import { POST } from "../../app/api/runtime/update/route";

function request(body: Record<string, unknown>, sameOrigin = true) {
  return new Request("http://localhost/api/runtime/update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: sameOrigin ? "http://localhost" : "https://attacker.invalid",
      "sec-fetch-site": sameOrigin ? "same-origin" : "cross-site",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  mocks.status.current.sourceFingerprint = "source-a";
  mocks.createUpdateBackup.mockClear();
  mocks.executeManagedUpdateAction.mockClear();
  mocks.recordSecurityActivity.mockClear();
  resetSensitiveActionConfirmationsForTests();
});

describe("Update Center route", () => {
  it("rejects cross-origin mutations before preparing an action", async () => {
    const response = await POST(request({ phase: "prepare", action: "update" }, false));
    expect(response.status).toBe(403);
    expect(mocks.createUpdateBackup).not.toHaveBeenCalled();
    expect(mocks.executeManagedUpdateAction).not.toHaveBeenCalled();
  });

  it("binds update approval to the exact source state and consumes it once", async () => {
    const prepared = await POST(request({ phase: "prepare", action: "update" }));
    expect(prepared.status).toBe(200);
    const payload = await prepared.json() as { confirmation: { token: string; impact: string[] } };
    expect(payload.confirmation.impact).toContain("automatic_backup");

    mocks.status.current.sourceFingerprint = "source-changed";
    const changed = await POST(request({ phase: "execute", action: "update", token: payload.confirmation.token }));
    expect(changed.status).toBe(409);
    expect(mocks.createUpdateBackup).not.toHaveBeenCalled();

    mocks.status.current.sourceFingerprint = "source-a";
    const preparedAgain = await POST(request({ phase: "prepare", action: "update" }));
    const next = await preparedAgain.json() as { confirmation: { token: string } };
    const executed = await POST(request({ phase: "execute", action: "update", token: next.confirmation.token }));
    expect(executed.status).toBe(200);
    expect(mocks.createUpdateBackup).toHaveBeenCalledTimes(1);
    expect(mocks.executeManagedUpdateAction).toHaveBeenCalledWith("update", {
      targetTag: "v2026.08.31",
      backup: mocks.backup,
    });

    const replay = await POST(request({ phase: "execute", action: "update", token: next.confirmation.token }));
    expect(replay.status).toBe(409);
    expect(mocks.createUpdateBackup).toHaveBeenCalledTimes(1);
  });

  it("requires an existing private backup before rollback review", async () => {
    const missingSelection = await POST(request({ phase: "prepare", action: "rollback" }));
    expect(missingSelection.status).toBe(409);

    const missingBackup = await POST(request({ phase: "prepare", action: "rollback", backupId: "source-missing" }));
    expect(missingBackup.status).toBe(404);
    expect(mocks.executeManagedUpdateAction).not.toHaveBeenCalled();
  });
});
