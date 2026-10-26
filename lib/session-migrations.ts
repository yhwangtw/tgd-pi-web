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
    if (value.version === 1 && value.sourceId === id && typeof value.sessionId === "string" && /^[a-zA-Z0-9_:-]{1,200}$/.test(value.sessionId)) return value;
  } catch { /* No published migration. The original remains authoritative. */ }
}
/** Keep aliases even after deletion, so old bookmarks never resurrect backups. */
export function resolveMigratedSessionId(id: string): string {
  const visited = new Set<string>();
  let current = id;
  for (let depth = 0; depth < 32; depth++) {
    if (visited.has(current)) return id;
    visited.add(current);
    const target = readSessionMigration(current)?.sessionId;
    if (!target || target === current) return current;
    current = target;
  }
  return id;
}
/** Alias lookup only: opening a session never starts a conversion or another engine. */
export async function waitForSessionMigration(id: string): Promise<string> {
  return resolveMigratedSessionId(id);
}
export function publishSessionMigration(receipt: SessionMigration): void {
  mkdirSync(migrationDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${path(receipt.sourceId)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, path(receipt.sourceId));
}
