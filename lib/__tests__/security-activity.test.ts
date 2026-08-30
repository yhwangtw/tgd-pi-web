import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSecurityActivity,
  readSecurityActivityStore,
  recordSecurityActivity,
  SECURITY_ACTIVITY_LIMIT,
  SECURITY_ACTIVITY_RETENTION_DAYS,
  writeSecurityActivityStore,
  type SecurityActivityEntry,
} from "../security-activity";

const tempDirs: string[] = [];

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-security-activity-"));
  tempDirs.push(directory);
  return join(directory, "security-activity.json");
}

function entry(index: number, timestamp = new Date().toISOString()): SecurityActivityEntry {
  return {
    id: `entry-${index}`,
    timestamp,
    category: "package",
    action: "install",
    outcome: "success",
    summary: `Installed package ${index}`,
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("security activity store", () => {
  it("writes a private atomic store and redacts secrets", () => {
    const path = tempPath();
    recordSecurityActivity({
      category: "mcp",
      action: "save",
      outcome: "success",
      summary: "Saved token=super-secret",
      target: "https://alice:password@example.com/mcp?api_key=top-secret",
      details: { authorization: "Bearer abcdef123456", env: "${GITHUB_TOKEN}" },
    }, path);

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("top-secret");
    expect(raw).not.toContain("abcdef123456");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain("${GITHUB_TOKEN}");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("drops expired entries and caps the retained history", () => {
    const path = tempPath();
    const now = new Date("2026-08-30T12:00:00.000Z");
    const expired = new Date(now.getTime() - (SECURITY_ACTIVITY_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    writeSecurityActivityStore({
      version: 1,
      entries: [
        ...Array.from({ length: SECURITY_ACTIVITY_LIMIT + 2 }, (_, index) => entry(index, now.toISOString())),
        entry(9999, expired),
      ],
    }, path, now);

    const store = readSecurityActivityStore(path, now);
    expect(store.entries).toHaveLength(SECURITY_ACTIVITY_LIMIT);
    expect(store.entries.some((item) => item.id === "entry-9999")).toBe(false);
  });

  it("clears the current history", () => {
    const path = tempPath();
    recordSecurityActivity({ category: "snapshot", action: "restore", outcome: "reviewed", summary: "Reviewed" }, path);
    expect(clearSecurityActivity(path)).toBe(1);
    expect(readSecurityActivityStore(path).entries).toEqual([]);
  });
});
