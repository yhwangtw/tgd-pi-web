import { beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ exec: vi.fn(), allowed: new Set(["/fixture/repo"]), roots: vi.fn(), branch: "main...origin/main [ahead 1]", status: " M file.txt\0" }));
vi.mock("node:child_process", () => ({ execFile: harness.exec }));
vi.mock("child_process", () => ({ execFile: harness.exec }));
vi.mock("../file-security", () => ({ getAllowedRoots: harness.roots }));
import { GET } from "../../app/api/git/changes/route";
const request = () => GET(new Request("http://localhost/api/git/changes?cwd=%2Ffixture%2Frepo"));

beforeEach(() => {
  harness.allowed.clear(); harness.allowed.add("/fixture/repo");
  harness.roots.mockReset().mockImplementation(async () => new Set(harness.allowed));
  harness.branch = "main...origin/main [ahead 1]"; harness.status = " M file.txt\0";
  harness.exec.mockReset().mockImplementation((_program, args, _options, callback) => {
    queueMicrotask(() => callback(null, { stdout: args.includes("status") ? `## ${harness.branch}\0${harness.status}` : "2\t1\tfile.txt\0" }));
  });
});

describe("Git changes request coalescing", () => {
  it("uses two processes total for concurrent readers and rechecks permission for each", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, request));
    expect(harness.exec).toHaveBeenCalledTimes(2);
    expect(harness.roots).toHaveBeenCalledTimes(20);
    expect(await responses[0].json()).toEqual({ git: true, branch: "main", files: [{ path: "file.txt", status: "M", additions: 2, deletions: 1 }] });
    harness.allowed.clear();
    expect((await request()).status).toBe(403);
    expect(harness.exec).toHaveBeenCalledTimes(2);
  });

  it("does not cache completed results, so the next edit appears immediately", async () => {
    await request();
    harness.status = "?? fresh.txt\0";
    expect((await (await request()).json()).files).toEqual([{ path: "fresh.txt", status: "??", additions: null, deletions: null }]);
    expect(harness.exec).toHaveBeenCalledTimes(4);
  });

  it("preserves unborn and detached HEAD branch responses", async () => {
    harness.branch = "No commits yet on fresh";
    expect((await (await request()).json()).branch).toBeNull();
    harness.branch = "HEAD (no branch)";
    expect((await (await request()).json()).branch).toBe("HEAD");
  });
});
