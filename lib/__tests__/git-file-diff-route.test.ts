import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../../app/api/git/file-diff/route";
import { POST } from "../../app/api/git/file-hunks/route";
import { readFileSnapshot, replaceFileSnapshot, withFileMutation } from "../versioned-file";

const allowed = vi.hoisted(() => new Set<string>());
vi.mock("../file-security", () => ({ getAllowedRoots: async () => allowed }));

let cwd = "";
const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
function git(...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}
async function get(path = "file.txt") {
  const response = await GET(new Request(`http://localhost/api/git/file-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`));
  return { response, data: await response.json() };
}
async function revert(data: { version: string; hunks: Array<{ index: number; id: string }> }, index = 0, path = "file.txt") {
  return POST(new Request("http://localhost/api/git/file-hunks", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, index, version: data.version, hunkId: data.hunks[index]?.id }),
  }));
}
async function changed() {
  const next = [...lines]; next[2] = "changed first"; next[32] = "changed second";
  await fs.writeFile(join(cwd, "file.txt"), next.join("\n") + "\n");
  return next;
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(join(tmpdir(), "pi-web-diff-test-"));
  allowed.add(cwd);
  git("init", "--quiet");
  await fs.writeFile(join(cwd, "file.txt"), lines.join("\n") + "\n");
  git("add", "file.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
});
afterEach(async () => { allowed.clear(); await fs.rm(cwd, { recursive: true, force: true }); });

describe("versioned diff routes", () => {
  it("reverts only the selected hunk and leaves the real Git index untouched", async () => {
    const next = await changed();
    const beforeIndex = git("diff", "--cached");
    const { data, response } = await get();
    expect(response.status).toBe(200);
    expect(data.hunks).toHaveLength(2);
    expect(data.newText).toContain("changed second");
    expect((await revert(data, 1)).status).toBe(200);
    next[32] = lines[32];
    expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe(next.join("\n") + "\n");
    expect(git("diff", "--cached")).toBe(beforeIndex);
    expect((await revert(data, 0)).status).toBe(409);
  });
  it("rejects an old index after unrelated content shifts the hunks", async () => {
    await changed();
    const { data } = await get();
    await fs.appendFile(join(cwd, "file.txt"), "new external edit\n");
    const latest = await fs.readFile(join(cwd, "file.txt"), "utf8");
    expect((await revert(data)).status).toBe(409);
    expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe(latest);
  });
  it("rejects missing or tampered hunk tokens", async () => {
    await changed();
    const { data } = await get();
    expect((await revert({ ...data, version: undefined })).status).toBe(400);
    data.hunks[0].id = "0".repeat(64);
    expect((await revert(data)).status).toBe(409);
  });
  it("allows one concurrent mutation and rejects its stale duplicate", async () => {
    await changed();
    const { data } = await get();
    const responses = await Promise.all([revert(data), revert(data)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it("handles a new file and a deleted file without touching other paths", async () => {
    await fs.writeFile(join(cwd, "new.txt"), "new content\n");
    const added = await get("new.txt");
    expect((await revert(added.data, 0, "new.txt")).status).toBe(200);
    await expect(fs.stat(join(cwd, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.unlink(join(cwd, "file.txt"));
    const removed = await get();
    expect((await revert(removed.data)).status).toBe(200);
    expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe(lines.join("\n") + "\n");
  });
  it("preserves CRLF and missing final newlines", async () => {
    await fs.writeFile(join(cwd, "file.txt"), "one\r\ntwo\r\nthree");
    git("add", "file.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "CRLF");
    await fs.writeFile(join(cwd, "file.txt"), "one\r\nchanged\r\nthree");
    const { data } = await get();
    expect((await revert(data)).status).toBe(200);
    expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe("one\r\ntwo\r\nthree");
  });
  it("rejects symlinks, path traversal and internal Git paths", async () => {
    await fs.symlink(join(cwd, "file.txt"), join(cwd, "link.txt"));
    expect((await get("link.txt")).response.status).toBe(403);
    expect((await get("../escape.txt")).response.status).toBe(403);
    expect((await get(".git/config")).response.status).toBe(403);
    await fs.symlink(cwd, join(cwd, "linked"));
    expect((await get("linked/file.txt")).response.status).toBe(403);
  });
  it("does not treat an oversized HEAD as an empty new file", async () => {
    await fs.writeFile(join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
    git("add", "large.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "large");
    await fs.writeFile(join(cwd, "large.txt"), "small");
    expect((await get("large.txt")).data.tooLarge).toBe(true);
  });
  it("rejects changed content before atomic replacement and removes its temp file", async () => {
    const snapshot = await readFileSnapshot(cwd, "file.txt", 4096);
    await fs.writeFile(join(cwd, "file.txt"), "external change");
    await expect(withFileMutation(cwd, "file.txt", () => replaceFileSnapshot(cwd, "file.txt", snapshot, "stale save", 4096))).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe("external change");
    expect((await fs.readdir(cwd)).filter(p => p.startsWith(".pi-save-"))).toEqual([]);
  });
});
