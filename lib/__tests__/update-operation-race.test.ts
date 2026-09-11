import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { releaseUpdateOperation, reserveUpdateOperation } from "../../scripts/update-operation-store.mjs";

const interception = vi.hoisted(() => ({ afterRead: null as null | ((path: string) => Promise<void>) }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    await interception.afterRead?.(String(args[0]));
    return content;
  } };
});
let directory: string;
afterEach(async () => { interception.afterRead = null; if (directory) await rm(directory, { recursive: true, force: true }); });

it("serializes lock ownership check and unlink so a stale release cannot delete the next reservation", async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-update-lock-race-"));
  const operation = await reserveUpdateOperation(directory, { action: "restart", cwd: directory });
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(done => { resume = done; });
  const reading = new Promise<void>(done => { entered = done; });
  let intercepted = false;
  interception.afterRead = async path => {
    if (path.endsWith("active.lock") && !intercepted) { intercepted = true; entered(); await paused; }
  };
  const staleRelease = releaseUpdateOperation(directory, operation.id);
  await reading;
  let secondReleased = false;
  const competingRelease = releaseUpdateOperation(directory, operation.id).then(() => { secondReleased = true; });
  await new Promise(done => setTimeout(done, 25));
  const interleaved = secondReleased;
  resume();
  await Promise.all([staleRelease, competingRelease]);
  expect(interleaved).toBe(false);
  const next = await reserveUpdateOperation(directory, { action: "restart", cwd: directory });
  await releaseUpdateOperation(directory, operation.id);
  await expect(reserveUpdateOperation(directory, { action: "restart", cwd: directory })).rejects.toMatchObject({ code: "UPDATE_OPERATION_CONFLICT" });
  expect(next.id).not.toBe(operation.id);
});
