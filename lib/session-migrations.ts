import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SessionMigration {
  version: 1;
  sourceId: string;
  sessionId: string;
  sourcePath: string;
  sourceHash: string;
  migratedAt: string;
}
export const migrationDirectory = () => join(getAgentDir(), "session-migrations");
export const migrationKey = (id: string) => createHash("sha256").update(id).digest("hex");
const path = (id: string) => join(migrationDirectory(), `${migrationKey(id)}.json`);
export function readSessionMigration(id: string): SessionMigration | undefined {
  try {
    const value = JSON.parse(readFileSync(path(id), "utf8")) as SessionMigration;
    if (value.version === 1 && value.sourceId === id && /^dw_[a-f0-9-]{36}_[1-9][0-9]*$/i.test(value.sessionId)) return value;
  } catch { /* No published migration. The original remains authoritative. */ }
}
/** Keep aliases even after deletion, so old bookmarks never resurrect backups. */
export function resolveMigratedSessionId(id: string): string { return readSessionMigration(id)?.sessionId ?? id; }
export function publishSessionMigration(receipt: SessionMigration): void {
  mkdirSync(migrationDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${path(receipt.sourceId)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, path(receipt.sourceId));
}
/** Explicit new Standard sessions remain Standard on subsequent turns. */
export function keepStandardSession(id: string): void {
  mkdirSync(migrationDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(join(migrationDirectory(), `${migrationKey(id)}.standard`), "1", { mode: 0o600 });
}
export function isStandardSession(id: string): boolean {
  try { return readFileSync(join(migrationDirectory(), `${migrationKey(id)}.standard`), "utf8") === "1"; } catch { return false; }
}
