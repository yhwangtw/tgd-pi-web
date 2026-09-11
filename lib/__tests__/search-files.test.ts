import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { searchFiles, resolveSearchRoot } from "../search-files";
import { grepProject } from "../grep";

describe("one file-search scope", () => {
  let root: string;
  const file = (name: string, text = "scope needle\n") => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "search-scope-"));
    mkdirSync(path.join(root, ".git"));
    file(".gitignore", "*.log\nignored/\n.worktrees/\n");
    file("src/needle.ts");
    file("src/needle.log");
    file("src/.gitignore", "!needle.log\n");
    file("needle.log");
    file("ignored/needle.ts");
    file(".hidden/needle.ts");
    file(".worktrees/old/.git", "gitdir: /not-followed\n");
    file(".worktrees/old/needle.ts");
    file("nested/.git", "gitdir: /not-followed\n");
    file("nested/needle.ts");
    file("node_modules/needle.ts");
    symlinkSync(path.join(root, "src/needle.ts"), path.join(root, "linked-needle.ts"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("respects nested ignore negation and defaults to this checkout", async () => {
    expect((await searchFiles(root, "needle")).results.map((hit) => hit.relative)).toEqual(["src/needle.log", "src/needle.ts"]);
    expect((await searchFiles(path.join(root, "src"), "needle")).results.map((hit) => hit.relative)).toEqual(["needle.log", "needle.ts"]);
  });

  it("keeps hidden, ignored and nested checkouts explicit and independent", async () => {
    const hidden = (await searchFiles(root, "needle", { includeHidden: true })).results.map((hit) => hit.relative);
    expect(hidden).toContain(".hidden/needle.ts");
    expect(hidden).not.toContain(".worktrees/old/needle.ts");
    const ignored = (await searchFiles(root, "needle", { includeIgnored: true })).results.map((hit) => hit.relative);
    expect(ignored).toContain("ignored/needle.ts");
    expect(ignored).not.toContain("nested/needle.ts");
    const nested = (await searchFiles(root, "needle", { includeWorktrees: true })).results.map((hit) => hit.relative);
    expect(nested).toContain("nested/needle.ts");
    expect(nested).toContain(".worktrees/old/needle.ts");
    expect(nested).not.toContain(".hidden/needle.ts");
    const all = (await searchFiles(root, "needle", { includeHidden: true, includeIgnored: true, includeWorktrees: true })).results;
    expect(all.some((hit) => /node_modules|linked-needle/.test(hit.relative))).toBe(false);
    expect((await searchFiles(path.join(root, ".worktrees/old"), "needle")).results).toHaveLength(1);
  });

  it("gives native and fallback content engines the same file universe", async () => {
    for (const options of [{}, { includeHidden: true, includeIgnored: true, includeWorktrees: true }]) {
      const names = (await searchFiles(root, "needle", options)).results.map((hit) => hit.relative).sort();
      const native = await grepProject(root, "scope needle", options);
      let hasRg = false;
      try { execFileSync("rg", ["--version"], { stdio: "ignore" }); hasRg = true; } catch { /* optional tool */ }
      if (hasRg) expect(native.engine).toBe("rg");
      const fallback = await grepProject(root, "scope needle", { ...options, engine: "js" });
      expect(native.matches.map((hit) => hit.relative).sort()).toEqual(names);
      expect(fallback.matches).toEqual(native.matches);
    }
  });

  it("reports real limits and aborts without returning a stale partial success", async () => {
    expect((await searchFiles(root, "needle", { maxResults: 1 })).truncated).toBe(true);
    expect((await searchFiles(root, "needle", { maxResults: 2 })).truncated).toBe(false);
    expect((await searchFiles(root, "absent", { maxEntries: 1 })).truncated).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(searchFiles(root, "needle", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not silently cap each file at 50 lines and normalizes Chinese columns", async () => {
    file("src/needle.ts", Array.from({ length: 65 }, () => "中文 needle\n").join(""));
    for (const engine of [undefined, "js"] as const) {
      const result = await grepProject(path.join(root, "src"), "中文 needle", { engine, maxResults: 65 });
      expect(result.matches).toHaveLength(65);
      expect(result.truncated).toBe(false);
      const capped = await grepProject(path.join(root, "src"), "needle", { engine, maxResults: 1 });
      expect(capped.truncated).toBe(true);
      // The first result is needle.log; select the Chinese match separately.
      const chinese = await grepProject(path.join(root, "src"), "needle", { engine, maxResults: 100 });
      expect(chinese.matches.find((hit) => hit.relative === "needle.ts")?.col).toBe(4);
    }
  });

  it("allows a root alias but rejects a descendant symlink escaping its allowed root", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "search-outside-"));
    try {
      symlinkSync(outside, path.join(root, "escape"));
      symlinkSync(root, path.join(outside, "alias"));
      expect(await resolveSearchRoot(path.join(root, "escape"), new Set([root]))).toBeNull();
      expect(await resolveSearchRoot(path.join(outside, "alias/src"), new Set([path.join(outside, "alias")]))).toBe(path.join(outside, "alias/src"));
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
