import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, PUT } from "../../app/api/files/[...path]/route";

const allowed = vi.hoisted(() => new Set<string>());
vi.mock("../file-security", async importActual => ({
  ...await importActual<typeof import("../file-security")>(),
  getAllowedRoots: async () => allowed,
}));

describe("versioned file editor API", () => {
  let root: string;
  let file: string;
  const params = () => ({ params: Promise.resolve({ path: file.split(path.sep).filter(Boolean) }) });
  const load = () => GET(new NextRequest(`http://localhost/api/files/${file}?type=read`), params());
  const save = (content: string, expectedVersion?: string) => PUT(new NextRequest(`http://localhost/api/files/${file}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, expectedVersion }),
  }), params());
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pi-editor-test-"));
    file = path.join(root, "note.txt");
    allowed.add(root);
    await writeFile(file, "original\n");
  });
  afterEach(async () => { allowed.clear(); await rm(root, { recursive: true, force: true }); });

  it("requires the loaded version and returns a fresh version after saving", async () => {
    const loaded = await (await load()).json();
    expect(loaded.version).toMatch(/^[a-f0-9]{64}$/);
    expect((await save("unversioned")).status).toBe(428);
    expect(await readFile(file, "utf8")).toBe("original\n");
    const response = await save("saved\r\n", loaded.version);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.version).toMatch(/^[a-f0-9]{64}$/);
    expect(result.version).not.toBe(loaded.version);
    expect(result.content).toBe("saved\r\n");
    expect(await readFile(file, "utf8")).toBe("saved\r\n");
  });

  it("returns the disk version on conflict without overwriting either side", async () => {
    const loaded = await (await load()).json();
    await writeFile(file, "external edit\n");
    const response = await save("my draft\n", loaded.version);
    expect(response.status).toBe(409);
    const conflict = await response.json();
    expect(conflict.current.content).toBe("external edit\n");
    expect(conflict.current.version).not.toBe(loaded.version);
    expect(await readFile(file, "utf8")).toBe("external edit\n");
    expect((await save("reviewed merge\n", conflict.current.version)).status).toBe(200);
  });

  it("rejects a concurrent stale save, a replaced symlink and a missing file", async () => {
    const loaded = await (await load()).json();
    const responses = await Promise.all([save("first", loaded.version), save("second", loaded.version)]);
    expect(responses.map(result => result.status).sort()).toEqual([200, 409]);
    await rm(file);
    expect((await save("no recreation", loaded.version)).status).toBe(404);
    await writeFile(path.join(root, "other.txt"), "keep");
    await symlink(path.join(root, "other.txt"), file);
    expect((await save("no follow", loaded.version)).status).toBe(403);
    expect(await readFile(path.join(root, "other.txt"), "utf8")).toBe("keep");
  });
});
