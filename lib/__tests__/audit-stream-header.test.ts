import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchFileResponse } from "../file-watch";
import { readSessionHeader } from "../session-header";
import { trimToUtf8Boundary } from "../text-prefix";

afterEach(() => vi.restoreAllMocks());
describe("file watcher ownership", () => {
  beforeEach(() => vi.spyOn(fs, "statSync").mockReturnValue({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, mtime: new Date(4) } as fs.Stats));
  it("closes once on abort, including repeat abort and subsequent cancellation", async () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.spyOn(fs, "watch").mockReturnValue(watcher as unknown as fs.FSWatcher);
    const abort = new AbortController();
    const response = watchFileResponse("/isolated.txt", abort.signal);
    const reader = response.body!.getReader(); const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('"revision":"1:2:3:4:5"');
    abort.abort(); abort.abort(); await reader.cancel();
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });
  it("does not open a watcher when already aborted and cleans up errors/cancellation", async () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    const watch = vi.spyOn(fs, "watch").mockReturnValue(watcher as unknown as fs.FSWatcher);
    const canceled = new AbortController(); canceled.abort();
    await watchFileResponse("/isolated.txt", canceled.signal).text(); expect(watch).not.toHaveBeenCalled();
    const response = watchFileResponse("/isolated.txt", new AbortController().signal);
    watcher.emit("error", new Error("gone")); await response.text(); expect(watcher.close).toHaveBeenCalledTimes(1);
    const second = watchFileResponse("/isolated.txt", new AbortController().signal); await second.body!.cancel(); expect(watcher.close).toHaveBeenCalledTimes(2);
  });
});
describe("bounded session header reads", () => {
  it("supports split multibyte/long headers and ignores a large or malformed transcript", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "pi-header-audit-")); const file = join(dir, "session.jsonl");
    const header = { type: "session", id: "id", cwd: "/project", timestamp: "now", extra: "字".repeat(3000) };
    try {
      fs.writeFileSync(file, JSON.stringify(header) + "\r\n" + "invalid".repeat(1000000));
      expect(readSessionHeader(file)).toEqual(header);
      fs.writeFileSync(file, JSON.stringify(header)); expect(readSessionHeader(file)).toEqual(header);
      fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1)); expect(readSessionHeader(file)).toBeNull();
      fs.writeFileSync(file, "{broken}\n"); expect(readSessionHeader(file)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("preserves actual replacement characters while dropping only partial UTF-8 sequences", () => {
    expect(trimToUtf8Boundary(Buffer.from("hello�")).toString()).toBe("hello�");
    expect(trimToUtf8Boundary(Buffer.from("abc字").subarray(0, 5)).toString()).toBe("abc");
  });
});
