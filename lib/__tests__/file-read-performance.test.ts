import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
const harness = vi.hoisted(() => ({ roots: new Set<string>(), read: vi.fn(), html: vi.fn() }));
vi.mock("../file-security", async actual => ({ ...await actual<typeof import("../file-security")>(), getAllowedRoots: async () => new Set(harness.roots) }));
vi.mock("../file-editor", async actual => {
  const original = await actual<typeof import("../file-editor")>();
  return { ...original, readEditableFile: (...args: Parameters<typeof original.readEditableFile>) => { harness.read(); return original.readEditableFile(...args); } };
});
vi.mock("../file-read-coalescing", async actual => {
  const original = await actual<typeof import("../file-read-coalescing")>();
  return { coalesceFileRead: <T,>(kind: string, file: string, stat: fs.Stats, roots: Set<string>, read: () => Promise<T>) =>
    original.coalesceFileRead(kind, file, stat, roots, () => { if (kind === "html") harness.html(); return read(); }) };
});
import { GET } from "../../app/api/files/[...path]/route";
let root: string;
const load = (file: string, type = "read") => GET(new NextRequest(`http://localhost/api/files/${file}?type=${type}`), { params: Promise.resolve({ path: file.split(path.sep).filter(Boolean) }) });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-file-perf-"));
  harness.roots.add(root); harness.read.mockClear(); harness.html.mockClear();
});
afterEach(async () => { vi.restoreAllMocks(); harness.roots.clear(); await rm(root, { recursive: true, force: true }); });

describe("file API read work", () => {
  it("shares simultaneous versioned reads but sees later edits and denied requests immediately", async () => {
    const file = path.join(root, "note.txt"); await writeFile(file, "first");
    const results = await Promise.all(Array.from({ length: 20 }, () => load(file)));
    expect(results.every(response => response.status === 200)).toBe(true);
    expect(harness.read).toHaveBeenCalledTimes(1);
    const before = await results[0].json(); expect(before.content).toBe("first");
    await writeFile(file, "second edit");
    expect((await (await load(file)).json()).content).toBe("second edit");
    expect(harness.read).toHaveBeenCalledTimes(2);
    harness.roots.clear(); expect((await load(file)).status).toBe(403);
    expect(harness.read).toHaveBeenCalledTimes(2);
    harness.roots.add(root); await rm(file); await symlink(path.join(root, "other.txt"), file); await writeFile(path.join(root, "other.txt"), "private");
    expect((await load(file)).status).toBe(403);
  });

  it("shares simultaneous HTML builds while retaining asset freshness and root-policy checks", async () => {
    const file = path.join(root, "index.html");
    await writeFile(file, '<script src="app.js"></script>'); await writeFile(path.join(root, "app.js"), 'const value="first"');
    const results = await Promise.all(Array.from({ length: 12 }, () => load(file, "html-preview")));
    expect(results.every(response => response.status === 200)).toBe(true);
    expect(harness.html).toHaveBeenCalledTimes(1);
    const first = await results[0].json();
    await writeFile(path.join(root, "app.js"), 'const value="second"');
    const second = await (await load(file, "html-preview")).json();
    expect(second.revision).not.toBe(first.revision); expect(harness.html).toHaveBeenCalledTimes(2);
    harness.roots.clear(); expect((await load(file, "html-preview")).status).toBe(403);
  });

  it("lists directories using at most sixteen concurrent async stats with unchanged sorting and ignores", async () => {
    for (let index = 0; index < 40; index++) await writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "fixture");
    await mkdir(path.join(root, "folder")); await mkdir(path.join(root, "node_modules"));
    const original = fs.promises.stat.bind(fs.promises);
    let active = 0; let maximum = 0; let calls = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
      calls++; active++; maximum = Math.max(maximum, active);
      try { return await original(...args); } finally { active--; }
    });
    const result = await load(root, "list"); expect(result.status).toBe(200);
    const entries = (await result.json()).entries;
    expect(entries).toHaveLength(41); expect(entries[0]).toMatchObject({ name: "folder", isDir: true });
    expect(entries.at(-1).name).toBe("file-39.txt");
    expect(calls).toBe(42); expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(16);
  });
});
