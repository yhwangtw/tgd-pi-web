import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshot, parseSnapshotDiff, restoreSnapshot } from "../git-snapshot";

const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  // Keep real Git behavior while counting the restore subprocesses.
  const execFile = Object.assign(actual.execFile.bind(null), {
    [promisify.custom]: (...args: Parameters<typeof run>) => {
      if (args[0] === "git" && Array.isArray(args[1])) gitCalls.push([...args[1]]);
      return run(...args);
    },
  });
  return { ...actual, execFile };
});

describe("parseSnapshotDiff", () => {
  it("describes modified and deleted files as restores, and new files as removals", () => {
    expect(parseSnapshotDiff("M\0src/app.ts\0D\0old.md\0A\0new.txt\0")).toEqual([
      { path: "src/app.ts", action: "restore", status: "M" },
      { path: "old.md", action: "restore", status: "D" },
      { path: "new.txt", action: "remove", status: "A" },
    ]);
  });

  it("expands a rename into the two changes the restore will perform", () => {
    expect(parseSnapshotDiff("R100\0before.ts\0after.ts\0")).toEqual([
      { path: "after.ts", action: "remove", status: "R" },
      { path: "before.ts", action: "restore", status: "R" },
    ]);
  });

  it("removes only the destination of a copied file", () => {
    expect(parseSnapshotDiff("C090\0source.ts\0copy.ts\0")).toEqual([
      { path: "copy.ts", action: "remove", status: "C" },
    ]);
  });
});

describe("restoreSnapshot", () => {
  let cwd: string;
  let session: string;

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-snapshot-restore-test-"));
    session = `snapshot-test-${cwd.split("-").at(-1)}`;
    // Do not inherit the developer's global filters, hooks or rename settings.
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(cwd, "missing-global-config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    git("init", "-q");
    git("config", "gc.auto", "0");
    writeFileSync(join(cwd, "seed.txt"), "seed\n");
    git("add", "seed.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-qm", "fixture");
    gitCalls.length = 0;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("restores hundreds of modified/deleted files in bounded batches and removes new files", async () => {
    const files = Array.from({ length: 260 }, (_, i) => `file-${String(i).padStart(4, "0")}.txt`);
    for (const [i, file] of files.entries()) writeFileSync(join(cwd, file), `snapshot ${i}\n`);
    const snapshot = (await createSnapshot(cwd, session, "many files"))!;
    for (const [i, file] of files.entries()) {
      if (i % 31 === 0) rmSync(join(cwd, file));
      else writeFileSync(join(cwd, file), `changed ${i}\n`);
    }
    writeFileSync(join(cwd, "zz-new.txt"), "created after snapshot\n");
    gitCalls.length = 0;

    expect(await restoreSnapshot(cwd, session, snapshot.id)).toEqual({ restored: 260, removed: 1, failed: [] });
    for (const [i, file] of files.entries()) expect(readFileSync(join(cwd, file), "utf8")).toBe(`snapshot ${i}\n`);
    expect(existsSync(join(cwd, "zz-new.txt"))).toBe(false);
    const restores = gitCalls.filter((args) => args.includes("restore") || args.includes("checkout"));
    expect(restores).toHaveLength(3);
    for (const args of restores) {
      expect(args).toContain("--worktree");
      expect(args).toContain("--pathspec-file-nul");
      const pathspec = args.find((arg) => arg.startsWith("--pathspec-from-file="))!.split("=").slice(1).join("=");
      expect(existsSync(pathspec)).toBe(false);
    }
  });

  it("restores literal filenames including pathspec magic, newlines and leading dashes", async () => {
    const files = [
      "space name.txt", "[literal].txt", "literal*.txt", "literal?.txt", ":(glob)*.txt", ":(glob)missing-target",
      "line\nbreak.txt", "--leading.txt", "back\\slash.txt", "quotes\"'.txt", "utf8-龍.txt",
    ];
    for (const file of files) writeFileSync(join(cwd, file), `snapshot ${file}\n`);
    const snapshot = (await createSnapshot(cwd, session, "literal paths"))!;
    for (const file of files) writeFileSync(join(cwd, file), "changed\n");

    expect(await restoreSnapshot(cwd, session, snapshot.id)).toEqual({ restored: files.length, removed: 0, failed: [] });
    for (const file of files) expect(readFileSync(join(cwd, file), "utf8")).toBe(`snapshot ${file}\n`);
  });

  it("preserves the user's index bytes, staged content and HEAD during capture and restore", async () => {
    writeFileSync(join(cwd, "seed.txt"), "staged change\n");
    git("add", "seed.txt");
    const indexBefore = readFileSync(join(cwd, ".git", "index"));
    const headBefore = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "seed.txt"), "snapshot content\n");
    writeFileSync(join(cwd, "not-staged.txt"), "snapshot untracked\n");
    const snapshot = (await createSnapshot(cwd, session, "staged work"))!;
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
    writeFileSync(join(cwd, "seed.txt"), "newer content\n");
    rmSync(join(cwd, "not-staged.txt"));

    expect(await restoreSnapshot(cwd, session, snapshot.id)).toEqual({ restored: 2, removed: 0, failed: [] });
    expect(readFileSync(join(cwd, "seed.txt"), "utf8")).toBe("snapshot content\n");
    expect(readFileSync(join(cwd, "not-staged.txt"), "utf8")).toBe("snapshot untracked\n");
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
    expect(git("show", ":seed.txt")).toBe("staged change");
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
  });

  it("reports only the failed path when a batch partly fails, and continues restorations and removals", async () => {
    const files = ["bad.txt", "good-a.txt", "good-z.txt"];
    for (const file of files) writeFileSync(join(cwd, file), `snapshot ${file}\n`);
    const snapshot = (await createSnapshot(cwd, session, "partial failure"))!;
    const missingBlob = git("rev-parse", `${snapshot.commit}:bad.txt`);
    // Corrupt only this disposable fixture's loose blob to make real Git fail
    // for one path after other files in the same batch may have been written.
    rmSync(join(cwd, ".git", "objects", missingBlob.slice(0, 2), missingBlob.slice(2)));
    for (const file of files) writeFileSync(join(cwd, file), "changed\n");
    writeFileSync(join(cwd, "zz-new.txt"), "created later\n");

    expect(await restoreSnapshot(cwd, session, snapshot.id)).toEqual({ restored: 2, removed: 1, failed: ["bad.txt"] });
    for (const file of files.slice(1)) expect(readFileSync(join(cwd, file), "utf8")).toBe(`snapshot ${file}\n`);
    expect(existsSync(join(cwd, "zz-new.txt"))).toBe(false);
    const restores = gitCalls.filter((args) => args.includes("restore"));
    expect(restores.length).toBeGreaterThan(1);
    for (const args of restores) {
      const pathspec = args.find((arg) => arg.startsWith("--pathspec-from-file="))!.slice("--pathspec-from-file=".length);
      expect(existsSync(pathspec)).toBe(false);
    }
  });

  it("removes a rename destination before restoring its original path", async () => {
    writeFileSync(join(cwd, "before.txt"), "unique rename content\n");
    const snapshot = (await createSnapshot(cwd, session, "rename"))!;
    renameSync(join(cwd, "before.txt"), join(cwd, "after.txt"));

    expect(await restoreSnapshot(cwd, session, snapshot.id)).toEqual({ restored: 1, removed: 1, failed: [] });
    expect(readFileSync(join(cwd, "before.txt"), "utf8")).toBe("unique rename content\n");
    expect(existsSync(join(cwd, "after.txt"))).toBe(false);
  });
});
