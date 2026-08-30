import { randomBytes } from "node:crypto";

export type SensitiveActionKind =
  | "mcp_stdio_test"
  | "skill_install"
  | "snapshot_restore"
  | "update_backup"
  | "update_apply"
  | "update_restart"
  | "update_rollback";

interface PendingSensitiveAction {
  kind: SensitiveActionKind;
  fingerprint: string;
  expiresAt: number;
}

declare global {
  var __piSensitiveActionConfirmations: Map<string, PendingSensitiveAction> | undefined;
}

const CONFIRMATION_TTL_MS = 60_000;

function store(): Map<string, PendingSensitiveAction> {
  globalThis.__piSensitiveActionConfirmations ??= new Map();
  const now = Date.now();
  for (const [token, pending] of globalThis.__piSensitiveActionConfirmations) {
    if (pending.expiresAt <= now) globalThis.__piSensitiveActionConfirmations.delete(token);
  }
  return globalThis.__piSensitiveActionConfirmations;
}

export function prepareSensitiveAction(
  kind: SensitiveActionKind,
  fingerprint: string,
): { token: string; expiresAt: number } {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  store().set(token, { kind, fingerprint, expiresAt });
  return { token, expiresAt };
}

export function consumeSensitiveAction(
  token: string,
  kind: SensitiveActionKind,
  fingerprint: string,
): boolean {
  const pending = store().get(token);
  store().delete(token);
  return !!pending
    && pending.expiresAt > Date.now()
    && pending.kind === kind
    && pending.fingerprint === fingerprint;
}

export function resetSensitiveActionConfirmationsForTests(): void {
  store().clear();
}
