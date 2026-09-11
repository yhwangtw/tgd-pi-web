import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileBodyStream, streamFile } from "../file-stream";

describe("bounded file responses", () => {
  let root: string;
  let file: string;
  let handles: FileHandle[];
  const openFixture = async () => {
    const handle = await open(file, "r");
    handles.push(handle);
    return handle;
  };
  beforeEach(async () => {
    handles = [];
    root = await mkdtemp(path.join(tmpdir(), "file-stream-"));
    file = path.join(root, "fixture.html");
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024, 97));
  });
  afterEach(async () => {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    await rm(root, { recursive: true, force: true });
  });

  it("pulls at most one 64KB chunk for a slow reader, then closes on cancel", async () => {
    const handle = await openFixture();
    const read = vi.spyOn(handle, "read");
    const stream = createFileBodyStream(handle, await handle.stat());
    const reader = stream.getReader();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();
    expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(read).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(handle.fd).toBe(-1);
  });

  it("closes even when an abandoned response was never read", async () => {
    const handle = await openFixture();
    const controller = new AbortController();
    const stream = createFileBodyStream(handle, await handle.stat(), { signal: controller.signal });
    controller.abort();
    await expect(stream.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(handle.fd).toBe(-1));
  });

  it("isolates active content on full, range and invalid-range responses", async () => {
    for (const mime of ["text/html; charset=utf-8", "image/svg+xml"]) {
      for (const range of [null, "bytes=1-4", "bytes=bad"]) {
        const handle = await openFixture();
        const response = await streamFile(file, await handle.stat(), mime, range, "inline", { handle });
        expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
        expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
        expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        if (range === "bytes=bad") { expect(response.status).toBe(416); expect(handle.fd).toBe(-1); }
        else if (range) expect(await response.text()).toBe("aaaa");
        else await response.body!.cancel();
      }
    }
  });

  it("serves suffix ranges and detects changes without silently mixing bytes", async () => {
    const handle = await openFixture();
    const response = await streamFile(file, await handle.stat(), "text/plain", "bytes=-2", "attachment", { handle });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("aa");
    expect(handle.fd).toBe(-1);
    const changed = await openFixture();
    const reader = createFileBodyStream(changed, await changed.stat()).getReader();
    await reader.read();
    await writeFile(file, "changed");
    await expect(reader.read()).rejects.toThrow("changed");
    expect(changed.fd).toBe(-1);
  });

  it("closes empty responses and rejects malformed or unsafe ranges", async () => {
    for (const range of ["bytes=-", "bytes=-0", "bytes=5-4", "bytes=9007199254740993-", "bytes=0-2,4-8", ""]) {
      const handle = await openFixture();
      const response = await streamFile(file, await handle.stat(), "text/plain", range, "inline", { handle });
      expect(response.status).toBe(416);
      expect(handle.fd).toBe(-1);
    }
    await writeFile(file, "");
    const handle = await openFixture();
    const response = await streamFile(file, await handle.stat(), "text/plain", null, "inline", { handle });
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(await response.text()).toBe("");
    expect(handle.fd).toBe(-1);
  });

  it("cancels an in-flight pull without enqueueing after cancellation", async () => {
    const handle = await openFixture();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(handle, "read").mockImplementationOnce(async () => {
      await ready;
      return { bytesRead: 1, buffer: Buffer.from("a") };
    });
    const reader = createFileBodyStream(handle, await handle.stat()).getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await reader.cancel();
    release();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(handle.fd).toBe(-1);
  });

  it("rejects a file changed between metadata lookup and stream creation", async () => {
    const handle = await openFixture();
    const metadata = await handle.stat();
    await writeFile(file, "new content");
    await expect(streamFile(file, metadata, "text/plain", null, "inline", { handle })).rejects.toThrow("changed");
    expect(handle.fd).toBe(-1);
  });
});
