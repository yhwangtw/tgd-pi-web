import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareCalendarVersions,
  createUpdateBackup,
  findUpdateBackup,
  getUpdateCenterStatus,
  parseManagedUpdateCommand,
  resetUpdateCenterCacheForTests,
  validateUpdateAction,
} from "../update-center";

const tempDirs: string[] = [];
const originalFetch = global.fetch;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; cwd: string; backupRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-update-center-"));
  tempDirs.push(root);
  const cwd = join(root, "app");
  const backupRoot = join(root, "backups");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "package.json"), '{"name":"fixture","version":"2026.08.27-1"}\n');
  writeFileSync(join(cwd, "tracked.txt"), "first\n");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Pi Web Test");
  git(cwd, "config", "user.email", "pi-web-test@example.invalid");
  git(cwd, "add", "package.json", "tracked.txt");
  git(cwd, "commit", "-qm", "fixture");
  return { root, cwd, backupRoot };
}

function release(version = "2026.08.31") {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({
    tag_name: `v${version}`,
    name: `Release ${version}`,
    html_url: `https://example.invalid/releases/v${version}`,
    published_at: "2026-08-31T00:00:00.000Z",
    body: "Release notes",
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  global.fetch = originalFetch;
  resetUpdateCenterCacheForTests();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Update Center", () => {
  it("compares calendar release tags including same-day sequences", () => {
    expect(compareCalendarVersions("2026.08.31", "v2026.08.31")).toBe(0);
    expect(compareCalendarVersions("2026.08.31", "2026.08.31-1")).toBeLessThan(0);
    expect(compareCalendarVersions("2026.09.01", "2026.08.31-9")).toBeGreaterThan(0);
  });

  it("accepts only absolute, shell-free managed argv arrays", () => {
    expect(parseManagedUpdateCommand('["/usr/local/libexec/pi-web-update","--safe"]')).toEqual({
      executable: "/usr/local/libexec/pi-web-update",
      args: ["--safe"],
    });
    expect(() => parseManagedUpdateCommand("bash setup.sh")).toThrow(/JSON argv array/);
    expect(() => parseManagedUpdateCommand('["bash","setup.sh"]')).toThrow(/absolute path/);
    expect(() => parseManagedUpdateCommand(JSON.stringify(Array.from({ length: 33 }, () => "x")))).toThrow(/1-32/);
  });

  it("reports release, source, backup, and managed-action readiness independently", async () => {
    const { cwd, backupRoot } = fixture();
    release();
    const status = await getUpdateCenterStatus({ cwd, backupRoot, env: { NODE_ENV: "test" } });

    expect(status.current).toMatchObject({ source: "git", version: "2026.08.27-1", dirty: false });
    expect(status.latest).toMatchObject({ tag: "v2026.08.31", version: "2026.08.31" });
    expect(status.updateAvailable).toBe(true);
    expect(status.actions.backup.ready).toBe(true);
    expect(status.actions.update).toMatchObject({ configured: false, ready: false, reason: "not_configured" });
    expect(status.preflight.ready).toBe(false);
    expect(status.backup.root).toBe(realpathSync(backupRoot));
  });

  it("creates a private Git recovery bundle with tracked and untracked changes", async () => {
    const { cwd, backupRoot } = fixture();
    writeFileSync(join(cwd, "tracked.txt"), "changed\n");
    writeFileSync(join(cwd, "new file.txt"), "untracked\n");

    const backup = await createUpdateBackup({ cwd, backupRoot, version: "2026.08.27-1" });
    expect(backup).toMatchObject({ source: "git", dirty: true, untrackedFiles: 1 });
    expect(statSync(backup.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(backup.path, "metadata.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(backup.path, "source.bundle"))).toBe(true);
    expect(existsSync(join(backup.path, "working-tree.patch"))).toBe(true);
    expect(readFileSync(join(backup.path, "working-tree.patch"), "utf8")).toContain("changed");
    expect(readFileSync(join(backup.path, "untracked", "new file.txt"), "utf8")).toBe("untracked\n");
    expect(await findUpdateBackup(backupRoot, backup.id)).toMatchObject({ id: backup.id });
    expect(await findUpdateBackup(backupRoot, "../escape")).toBeNull();
  });

  it("rejects update and rollback execution until their exact prerequisites are ready", async () => {
    const { cwd, backupRoot, root } = fixture();
    release();
    const helper = join(root, "helper");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, 0o700);
    const status = await getUpdateCenterStatus({
      cwd,
      backupRoot,
      env: {
        NODE_ENV: "test",
        PIWEB_UPDATE_COMMAND_JSON: JSON.stringify([helper]),
        PIWEB_RESTART_COMMAND_JSON: JSON.stringify([helper]),
        PIWEB_ROLLBACK_COMMAND_JSON: JSON.stringify([helper]),
      },
    });

    expect(validateUpdateAction(status, "update")).toBeNull();
    expect(validateUpdateAction(status, "rollback")).toMatch(/Choose a recovery backup/);
    expect(validateUpdateAction(status, "rollback", "source-known")).toBeNull();
  });
});
