import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isFileMutationLockPath, withFileMutationLock } from "../file-mutation-lock";
import { readFileSnapshot, withFileMutation } from "../versioned-file";
import { isPathAllowed } from "../file-security";
import { readSearchFile, walkSearchFiles } from "../search-files";

let directory: string;
let children: ChildProcess[];
const key = "/fixture/target.txt";

async function holder(lockDirectory = directory, target = key, expectedStatus?: number) {
  const child = fork(new URL("./fixtures/file-mutation-worker.mjs", import.meta.url), [lockDirectory, target], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const first = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => { throw new Error(`Lock worker exited ${code}: ${stderr}`); }),
  ]);
  if (expectedStatus) expect(first).toMatchObject({ type: "error", status: expectedStatus });
  else expect(first).toEqual({ type: "locked" });
  return child;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-file-mutex-"));
  children = [];
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
});

it("rejects another process on the same target but allows independent files", async () => {
  const child = await holder();
  await expect(withFileMutationLock(directory, key, async () => "must not run")).rejects.toMatchObject({ status: 409 });
  await expect(withFileMutationLock(directory, "/fixture/other.txt", async () => "independent")).resolves.toBe("independent");
  const released = once(child, "message");
  child.send("release");
  expect((await released)[0]).toEqual({ type: "released" });
  await expect(withFileMutationLock(directory, key, async () => "acquired")).resolves.toBe("acquired");
});

it("does not steal an old-looking lock and recovers immediately after its process dies", async () => {
  const child = await holder();
  const filename = join(directory, `${createHash("sha256").update(key).digest("hex")}.sqlite`);
  await fs.utimes(filename, new Date(0), new Date(0));
  await expect(withFileMutationLock(directory, key, async () => "must not run")).rejects.toMatchObject({ status: 409 });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await expect(withFileMutationLock(directory, key, async () => "recovered")).resolves.toBe("recovered");
});

it("keeps the first lock held after a second connection in the same process is rejected", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const holding = withFileMutationLock(directory, key, async () => { entered(); await gate; });
  await ready;
  try {
    await expect(withFileMutationLock(directory, key, async () => "must not run")).rejects.toMatchObject({ status: 409 });
    await holder(directory, key, 409);
  } finally { release(); await holding; }
});

it("releases on a failed action and refuses linked lock paths", async () => {
  await expect(withFileMutationLock(directory, key, async () => { throw new Error("action failed"); })).rejects.toThrow("action failed");
  await expect(withFileMutationLock(directory, key, async () => "released")).resolves.toBe("released");
  const target = join(directory, "keep.txt");
  await fs.writeFile(target, "keep");
  const linkedDirectory = join(directory, "linked");
  await fs.symlink(directory, linkedDirectory);
  await expect(withFileMutationLock(linkedDirectory, key, async () => "must not run")).rejects.toMatchObject({ status: 503 });
  const linkedKey = "linked target";
  await fs.symlink(target, join(directory, `${createHash("sha256").update(linkedKey).digest("hex")}.sqlite`));
  await expect(withFileMutationLock(directory, linkedKey, async () => "must not run")).rejects.toMatchObject({ status: 503 });
  expect(await fs.readFile(target, "utf8")).toBe("keep");
});

it("shares the cross-process lock with the production mutation wrapper", async () => {
  const file = join(directory, "content.txt");
  await fs.writeFile(file, "original");
  const canonical = await fs.realpath(file);
  const agentDirectory = await fs.realpath(process.env.PI_CODING_AGENT_DIR!);
  const child = await holder(join(agentDirectory, "file-mutation-locks"), canonical);
  await expect(withFileMutation(directory, "content.txt", async () => fs.writeFile(file, "wrong"))).rejects.toMatchObject({ status: 409 });
  expect(await fs.readFile(file, "utf8")).toBe("original");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await withFileMutation(directory, "content.txt", async () => fs.writeFile(file, "saved"));
  expect(await fs.readFile(file, "utf8")).toBe("saved");
});

it("excludes internal locks and aliases from reads without releasing the held OS lock", async () => {
  const agentDirectory = await fs.realpath(process.env.PI_CODING_AGENT_DIR!);
  const lockDirectory = join(agentDirectory, "file-mutation-locks");
  const filename = `${createHash("sha256").update(key).digest("hex")}.sqlite`;
  const lockedFile = join(lockDirectory, filename);
  const alias = join(directory, "agent-alias");
  await fs.symlink(agentDirectory, alias);
  await withFileMutationLock(lockDirectory, key, async () => {
    for (const target of [lockedFile, join(alias, "file-mutation-locks", filename)]) {
      expect(isFileMutationLockPath(target, agentDirectory)).toBe(true);
      expect(isPathAllowed(target, new Set([agentDirectory, directory]))).toBe(false);
      expect(await readSearchFile(target)).toBeNull();
    }
    await expect(readFileSnapshot(agentDirectory, `file-mutation-locks/${filename}`, 4096)).rejects.toMatchObject({ status: 403 });
    expect((await walkSearchFiles(agentDirectory, { includeHidden: true, includeIgnored: true })).entries.some(entry => entry.name === "file-mutation-locks")).toBe(false);
    expect((await walkSearchFiles(lockDirectory)).entries).toEqual([]);
    expect(isFileMutationLockPath(agentDirectory, agentDirectory)).toBe(false);
    expect(isFileMutationLockPath(agentDirectory, agentDirectory, { includeAncestors: true })).toBe(true);
    expect(isFileMutationLockPath(`${lockDirectory}-ordinary`, agentDirectory)).toBe(false);
    await holder(lockDirectory, key, 409);
  });
});
