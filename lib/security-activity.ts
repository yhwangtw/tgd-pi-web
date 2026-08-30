import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { redactSensitiveText, redactSensitiveValue } from "./redaction";

export const SECURITY_ACTIVITY_RETENTION_DAYS = 90;
export const SECURITY_ACTIVITY_LIMIT = 1_000;

export type SecurityActivityCategory = "package" | "mcp" | "skill" | "snapshot" | "extension" | "update" | "security";
export type SecurityActivityOutcome = "reviewed" | "success" | "denied" | "failure";

export interface SecurityActivityEntry {
  id: string;
  timestamp: string;
  category: SecurityActivityCategory;
  action: string;
  outcome: SecurityActivityOutcome;
  summary: string;
  target?: string;
  sessionId?: string;
  cwd?: string;
  details?: Record<string, unknown>;
}

export interface SecurityActivityStore {
  version: 1;
  entries: SecurityActivityEntry[];
}

export interface RecordSecurityActivityInput extends Omit<SecurityActivityEntry, "id" | "timestamp"> {
  timestamp?: string;
}

const CATEGORIES = new Set<SecurityActivityCategory>(["package", "mcp", "skill", "snapshot", "extension", "update", "security"]);
const OUTCOMES = new Set<SecurityActivityOutcome>(["reviewed", "success", "denied", "failure"]);

export function securityActivityPath(): string {
  return join(getAgentDir(), "security-activity.json");
}

function emptyStore(): SecurityActivityStore {
  return { version: 1, entries: [] };
}

function isEntry(value: unknown): value is SecurityActivityEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SecurityActivityEntry>;
  return typeof entry.id === "string"
    && typeof entry.timestamp === "string"
    && CATEGORIES.has(entry.category as SecurityActivityCategory)
    && typeof entry.action === "string"
    && OUTCOMES.has(entry.outcome as SecurityActivityOutcome)
    && typeof entry.summary === "string"
    && (entry.target === undefined || typeof entry.target === "string")
    && (entry.sessionId === undefined || typeof entry.sessionId === "string")
    && (entry.cwd === undefined || typeof entry.cwd === "string")
    && (entry.details === undefined || (!!entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)));
}

function withinRetention(entry: SecurityActivityEntry, nowMs: number): boolean {
  const timestamp = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  return nowMs - timestamp <= SECURITY_ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
}

export function readSecurityActivityStore(
  path = securityActivityPath(),
  now = new Date(),
): SecurityActivityStore {
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SecurityActivityStore>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
    return {
      version: 1,
      entries: entries.filter((entry) => withinRetention(entry, now.getTime())).slice(0, SECURITY_ACTIVITY_LIMIT),
    };
  } catch {
    return emptyStore();
  }
}

export function writeSecurityActivityStore(
  store: SecurityActivityStore,
  path = securityActivityPath(),
  now = new Date(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized: SecurityActivityStore = {
    version: 1,
    entries: store.entries
      .filter(isEntry)
      .filter((entry) => withinRetention(entry, now.getTime()))
      .slice(0, SECURITY_ACTIVITY_LIMIT)
      .map((entry) => redactSensitiveValue(entry)),
  };
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export function recordSecurityActivity(
  input: RecordSecurityActivityInput,
  path = securityActivityPath(),
): SecurityActivityEntry {
  const now = new Date(input.timestamp ?? Date.now());
  const entry = redactSensitiveValue<SecurityActivityEntry>({
    id: randomUUID(),
    timestamp: now.toISOString(),
    category: input.category,
    action: redactSensitiveText(input.action),
    outcome: input.outcome,
    summary: redactSensitiveText(input.summary),
    ...(input.target ? { target: redactSensitiveText(input.target) } : {}),
    ...(input.sessionId ? { sessionId: redactSensitiveText(input.sessionId) } : {}),
    ...(input.cwd ? { cwd: redactSensitiveText(input.cwd) } : {}),
    ...(input.details ? { details: redactSensitiveValue(input.details) } : {}),
  });
  const store = readSecurityActivityStore(path, now);
  store.entries.unshift(entry);
  writeSecurityActivityStore(store, path, now);
  return entry;
}

export function clearSecurityActivity(path = securityActivityPath()): number {
  const store = readSecurityActivityStore(path);
  const cleared = store.entries.length;
  writeSecurityActivityStore(emptyStore(), path);
  return cleared;
}
