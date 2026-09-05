import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { NextRequest } from "next/server";
import { DELETE, GET, POST, PUT } from "../../app/api/files/[...path]/route";
import { isFileMutationLockPath, withFileMutationLock } from "../file-mutation-lock";

const allowed = vi.hoisted(() => new Set<string>());
vi.mock("../file-security", async importActual => ({
  ...await importActual<typeof import("../file-security")>(),
  getAllowedRoots: async () => allowed,
}));

let root: string;
let agentDirectory: string;
const params = (file: string) => ({ params: Promise.resolve({ path: file.split(sep).filter(Boolean) }) });
const request = (file: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost/api/files/${file}`, {
  method,
  ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lock-access-"));
  agentDirectory = join(root, "runtime", "agent");
  await mkdir(agentDirectory, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
  allowed.add(root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  allowed.clear();
  await rm(root, { recursive: true, force: true });
});

it("blocks internal file access and ancestor mutations while allowing ordinary browsing", async () => {
  const key = "/fixture/shared.txt";
  const lockDirectory = join(agentDirectory, "file-mutation-locks");
  const filename = `${createHash("sha256").update(key).digest("hex")}.sqlite`;
  const lockedFile = join(lockDirectory, filename);
  const alias = join(root, "alias");
  await symlink(agentDirectory, alias);
  await withFileMutationLock(lockDirectory, key, async () => {
    for (const file of [lockedFile, join(alias, "file-mutation-locks", filename)]) {
      for (const type of ["read", "raw", "download", "meta", "watch", "preview", "list"]) {
        expect((await GET(new NextRequest(`http://localhost/api/files/${file}?type=${type}`), params(file))).status).toBe(403);
      }
      expect((await PUT(request(file, "PUT", { content: "overwrite", expectedVersion: "f".repeat(64) }), params(file))).status).toBe(403);
      expect((await DELETE(request(file, "DELETE"), params(file))).status).toBe(403);
    }
    for (const directory of [lockDirectory, agentDirectory, dirname(agentDirectory), alias]) {
      expect((await DELETE(request(directory, "DELETE"), params(directory))).status).toBe(403);
      expect((await POST(request(directory, "POST", { action: "rename", name: "moved" }), params(directory))).status).toBe(403);
    }
    const listing = await GET(request(agentDirectory), params(agentDirectory));
    expect(listing.status).toBe(200);
    expect((await listing.json()).entries).toEqual([]);
    expect((await lstat(lockedFile)).isFile()).toBe(true);
  });
});

it("reserves only the actual internal directory, including before it exists", async () => {
  const alias = join(root, "agent-alias");
  await symlink(agentDirectory, alias);
  for (const directory of [agentDirectory, alias]) {
    for (const action of ["create-file", "create-dir"]) {
      expect((await POST(request(directory, "POST", { action, name: "file-mutation-locks" }), params(directory))).status).toBe(403);
    }
  }
  const form = new FormData();
  form.append("files", new File(["not a lock"], "file-mutation-locks"));
  const upload = await POST(new NextRequest(`http://localhost/api/files/${agentDirectory}`, { method: "POST", body: form }), params(agentDirectory));
  expect((await upload.json()).results).toEqual([{ name: "file-mutation-locks", ok: false, error: "Access denied" }]);
  await expect(lstat(join(agentDirectory, "file-mutation-locks"))).rejects.toMatchObject({ code: "ENOENT" });
  const ordinary = await POST(request(root, "POST", { action: "create-dir", name: "file-mutation-locks" }), params(root));
  expect(ordinary.status).toBe(200);
});

it("rejects dangling aliases that would create a future internal file", async () => {
  const lockDirectory = join(agentDirectory, "file-mutation-locks");
  await mkdir(lockDirectory, { mode: 0o700 });
  const futureFile = join(lockDirectory, "future.sqlite");
  const alias = join(root, "lock-alias");
  await symlink(futureFile, alias);
  expect(isFileMutationLockPath(alias, agentDirectory)).toBe(true);
  const form = new FormData();
  form.append("files", new File(["must not be written"], "lock-alias"));
  const upload = await POST(new NextRequest(`http://localhost/api/files/${root}`, { method: "POST", body: form }), params(root));
  expect((await upload.json()).results).toEqual([{ name: "lock-alias", ok: false, error: "Access denied" }]);
  expect((await POST(request(root, "POST", { action: "create-file", name: "lock-alias" }), params(root))).status).toBe(403);
  await expect(lstat(futureFile)).rejects.toMatchObject({ code: "ENOENT" });
  const futureDirectory = join(root, "future-directory");
  await symlink(join(lockDirectory, "not-created"), futureDirectory);
  expect(isFileMutationLockPath(join(futureDirectory, "child.sqlite"), agentDirectory)).toBe(true);
});
