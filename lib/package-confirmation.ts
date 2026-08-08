import { randomBytes } from "node:crypto";

export type PackageMutationAction = "install" | "remove" | "update";

interface PendingPackageMutation {
  action: PackageMutationAction;
  source: string;
  sessionId: string;
  expiresAt: number;
}

declare global {
  var __piPackageConfirmations: Map<string, PendingPackageMutation> | undefined;
}

function store(): Map<string, PendingPackageMutation> {
  globalThis.__piPackageConfirmations ??= new Map();
  const now = Date.now();
  for (const [token, pending] of globalThis.__piPackageConfirmations) {
    if (pending.expiresAt <= now) globalThis.__piPackageConfirmations.delete(token);
  }
  return globalThis.__piPackageConfirmations;
}

export function preparePackageMutation(input: Omit<PendingPackageMutation, "expiresAt">): { token: string; expiresAt: number } {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + 60_000;
  store().set(token, { ...input, expiresAt });
  return { token, expiresAt };
}

export function consumePackageMutation(token: string, expected: Omit<PendingPackageMutation, "expiresAt">): boolean {
  const pending = store().get(token);
  store().delete(token);
  return !!pending
    && pending.expiresAt > Date.now()
    && pending.action === expected.action
    && pending.source === expected.source
    && pending.sessionId === expected.sessionId;
}
