import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../../app/api/git/changes/route";

const allowed = vi.hoisted(() => new Set<string>());
vi.mock("../file-security", () => ({ getAllowedRoots: async () => allowed }));
let cwd = "";
function git(...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}
async function changes() {
  const response = await GET(new Request(`http://localhost/api/git/changes?cwd=${encodeURIComponent(cwd)}`));
  expect(response.status).toBe(200);
  return (await response.json()).files as Array<{ path: string; status: string; additions: number | null; deletions: number | null }>;
}
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-web-changes-test-"));
  allowed.add(cwd);
  git("init", "--quiet");
  git("config", "core.quotePath", "true");
  await writeFile(join(cwd, "原始.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
});
afterEach(async () => { allowed.clear(); await rm(cwd, { recursive: true, force: true }); });

describe("Git changes preserve literal filenames", () => {
  it("lists Chinese uploads and modified-file stats without decoding Git escapes as JSON", async () => {
    await writeFile(join(cwd, "附件.pdf"), "fixture");
    await writeFile(join(cwd, "原始.txt"), "after\n");
    const files = await changes();
    expect(files).toContainEqual({ path: "附件.pdf", status: "??", additions: null, deletions: null });
    expect(files).toContainEqual({ path: "原始.txt", status: "M", additions: 1, deletions: 1 });
  });
  it("handles renamed paths, literal arrows, tabs, quotes and newlines", async () => {
    git("mv", "原始.txt", "renamed -> file.txt");
    await writeFile(join(cwd, "renamed -> file.txt"), "before\nextra\n");
    for (const path of ["literal -> name.txt", "tab\tfile.txt", "line\nbreak.txt", 'quote"file.txt']) await writeFile(join(cwd, path), "fixture");
    const files = await changes();
    expect(files).toContainEqual({ path: "renamed -> file.txt", status: "RM", additions: 1, deletions: 0 });
    for (const path of ["literal -> name.txt", "tab\tfile.txt", "line\nbreak.txt", 'quote"file.txt']) expect(files.some(file => file.path === path)).toBe(true);
    expect(files.some(file => file.path === "原始.txt")).toBe(false);
  });
  it("keeps the allowed-root boundary", async () => {
    allowed.clear();
    expect((await GET(new Request(`http://localhost/api/git/changes?cwd=${encodeURIComponent(cwd)}`))).status).toBe(403);
  });
});
