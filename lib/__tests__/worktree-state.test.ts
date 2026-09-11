import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readWorktreeState } from "../worktrees";
import { resolveWorkspaceIdentity } from "../workspace-identity";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("real Git workspace identity", () => {
  it("resolves symlink aliases, nested cwd and literal Unicode/newlines in paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-worktree-state-"));
    roots.push(root);
    const repo = join(root, '專案 "quoted"\nfolder');
    await mkdir(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: repo, stdio: "pipe" });
    const alias = join(root, "alias");
    await symlink(repo, alias, "dir");
    const result = await readWorktreeState(join(alias, "src"));
    expect(result.state).toBe("ready");
    expect(result.canonicalCwd).toBe(await realpath(join(repo, "src")));
    expect(resolveWorkspaceIdentity(result.canonicalCwd, result.worktrees)).toMatchObject({ state: "branch", branch: "main", root: await realpath(repo) });
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repo, stdio: "pipe" });
    const detached = await readWorktreeState(alias);
    expect(resolveWorkspaceIdentity(detached.canonicalCwd, detached.worktrees)).toMatchObject({ state: "detached", detached: true });
  });

  it("distinguishes a real non-repository from an inaccessible path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-worktree-state-"));
    roots.push(root);
    expect((await readWorktreeState(root)).state).toBe("not-git");
    expect((await readWorktreeState(join(root, "missing"))).state).toBe("unknown");
  });
});
