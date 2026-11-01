import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const io = vi.hoisted(() => ({ reads: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => { io.reads++; return actual.readFile(...args); } };
});
import { createSessionFileReader } from "../session-file-cache";
let root: string;
const header = { type: "session", version: 3, id: "cached", cwd: "/fixture", timestamp: "2026-11-01T00:00:00Z" };
const message = (text: string, id = "message1", parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: header.timestamp, message: { role: "user", content: text, timestamp: 1 } });
function source(text = "Original") { return [header, message(text)].map(item => JSON.stringify(item)).join("\n"); }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-session-file-cache-")); io.reads = 0; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("read-only session detail cache", () => {
  it("shares unchanged reads but gives every caller an independent mutable copy", async () => {
    const path = join(root, "session.jsonl"); const body = source(); await writeFile(path, body);
    const read = createSessionFileReader();
    const first = await read(path); const next = await read(path);
    expect(io.reads).toBe(1); expect(next).toEqual(first); expect(next.entries[0]).not.toBe(first.entries[0]);
    first.header!.cwd = "/changed";
    (first.entries[0] as { message: { content: string } }).message.content = "Modified by caller";
    const third = await read(path);
    expect(third.header!.cwd).toBe("/fixture");
    expect((third.entries[0] as { message: { content: string } }).message.content).toBe("Original");
    expect(await readFile(path, "utf8")).toBe(body);
  });
  it("coalesces simultaneous reads of the same revision", async () => {
    const path = join(root, "session.jsonl"); await writeFile(path, source()); const read = createSessionFileReader();
    const files = await Promise.all(Array.from({ length: 12 }, () => read(path)));
    expect(io.reads).toBe(1); expect(files).toHaveLength(12);
    expect(new Set(files.map(file => file.entries))).toHaveProperty("size", 12);
  });
  it("invalidates append, same-size replacement and preserved-mtime replacement", async () => {
    const path = join(root, "session.jsonl"); await writeFile(path, source()); const read = createSessionFileReader();
    await read(path);
    await writeFile(path, source() + "\n" + JSON.stringify(message("Next", "message2", "message1")));
    expect((await read(path)).entries).toHaveLength(2);
    const before = await stat(path); const replacement = join(root, "replacement.jsonl");
    await writeFile(replacement, source("Replaced") + "\n" + JSON.stringify(message("Next", "message2", "message1")));
    await utimes(replacement, before.atime, before.mtime); await rename(replacement, path);
    expect((await read(path)).entries[0]).toMatchObject({ message: { content: "Replaced" } });
    expect(io.reads).toBe(3);
  });
  it("never revives a deleted file or mixes files in different agent directories", async () => {
    const a = join(root, "a.jsonl"); const b = join(root, "b.jsonl");
    await writeFile(a, source("First")); await writeFile(b, source("Other")); const read = createSessionFileReader();
    expect((await read(a)).entries[0]).toMatchObject({ message: { content: "First" } });
    expect((await read(b)).entries[0]).toMatchObject({ message: { content: "Other" } });
    await rm(a); await expect(read(a)).rejects.toThrow();
    await writeFile(a, source("New file"));
    expect((await read(a)).entries[0]).toMatchObject({ message: { content: "New file" } });
  });
  it("evicts by least recent use and by retained source bytes", async () => {
    const a = join(root, "a.jsonl"); const b = join(root, "b.jsonl"); const c = join(root, "c.jsonl");
    for (const path of [a, b, c]) await writeFile(path, source());
    const read = createSessionFileReader({ maxFiles: 2 });
    await read(a); await read(b); await read(a); await read(c); expect(io.reads).toBe(3);
    await read(a); expect(io.reads).toBe(3); await read(b); expect(io.reads).toBe(4);
    const small = createSessionFileReader({ maxBytes: Buffer.byteLength(source()) + 1 }); io.reads = 0;
    await small(a); await small(b); await small(a); expect(io.reads).toBe(3);
  });
  it("serves oversized files without retaining them", async () => {
    const path = join(root, "session.jsonl"); await writeFile(path, source("Long ".repeat(1000)));
    const read = createSessionFileReader({ maxFileBytes: 128 });
    expect((await read(path)).entries).toHaveLength(1); await read(path); expect(io.reads).toBe(2);
  });
  it("keeps deeply nested tool details readable and independent beyond the native clone limit", async () => {
    const path = join(root, "deep.jsonl");
    let details: unknown = { "leaf": "original", ["__proto__"]: { safe: true } };
    for (let level = 0; level < 2200; level++) details = { nested: details };
    const body = [header, { ...message("Tool output"), message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "Tool output" }], details } }].map(item => JSON.stringify(item)).join("\n");
    await writeFile(path, body); const read = createSessionFileReader();
    const first = await read(path); const second = await read(path);
    const walk = (file: typeof first): Record<string, unknown> => {
      let value = (file.entries[0] as unknown as { message: { details: Record<string, unknown> } }).message.details;
      for (let level = 0; level < 2200; level++) value = value.nested as Record<string, unknown>;
      return value;
    };
    expect(walk(first).leaf).toBe("original");
    expect(Object.hasOwn(walk(first), "__proto__")).toBe(true);
    walk(first).leaf = "caller mutation";
    expect(walk(second).leaf).toBe("original");
    expect(JSON.stringify(second.entries[0])).toBe(body.split("\n")[1]);
    expect(io.reads).toBe(1);
  });

});
