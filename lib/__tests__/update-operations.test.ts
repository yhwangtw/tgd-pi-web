import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finishUpdateOperation, listUpdateOperations, readUpdateOperation, reserveUpdateOperation } from "../../scripts/update-operation-store.mjs";

const roots: string[] = [];
const input = { action: "update", cwd: "/tmp/fixture-app", expected: { version: "2026.09.07" }, before: { pid: process.pid } };
async function fixture() { const root = await mkdtemp(join(tmpdir(), "pi-update-operations-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("persistent managed update operations", () => {
  it("allows only one filesystem-backed reservation across concurrent callers", async () => {
    const root = await fixture();
    const attempts = await Promise.allSettled([reserveUpdateOperation(root, input), reserveUpdateOperation(root, input)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    const operation = attempts.find(result => result.status === "fulfilled")! as PromiseFulfilledResult<{ id: string }>;
    expect((await listUpdateOperations(root)).active?.id).toBe(operation.value.id);
    expect((await readUpdateOperation(root, operation.value.id)).status).toBe("reserved");
  });

  it("persists completion for a new reader and releases the matching lock", async () => {
    const root = await fixture();
    const operation = await reserveUpdateOperation(root, input);
    await finishUpdateOperation(root, operation.id, "succeeded", "Verified running build");
    const readback = await listUpdateOperations(root);
    expect(readback.active).toBeNull();
    expect(readback.recent[0]).toMatchObject({ id: operation.id, status: "succeeded" });
    expect(await readFile(join(root, `${operation.id}.json`), "utf8")).toContain("Verified running build");
    expect((await reserveUpdateOperation(root, input)).id).not.toBe(operation.id);
  });

  it("marks a dead supervisor interrupted after grace, never successful", async () => {
    const root = await fixture();
    const operation = await reserveUpdateOperation(root, input);
    await writeFile(join(root, `${operation.id}.json`), JSON.stringify({ ...operation, pid: 2147483647, updatedAt: "2000-01-01T00:00:00.000Z" }));
    expect((await listUpdateOperations(root)).recent[0].status).toBe("interrupted");
    expect((await listUpdateOperations(root)).active?.id).toBe(operation.id);
    await expect(reserveUpdateOperation(root, input)).rejects.toMatchObject({ code: "UPDATE_OPERATION_CONFLICT" });
  });

  it("does not reclaim a lock while its helper is still alive", async () => {
    const root = await fixture();
    const operation = await reserveUpdateOperation(root, input);
    await writeFile(join(root, `${operation.id}.json`), JSON.stringify({ ...operation, pid: 2147483647, helperPid: process.pid, updatedAt: "2000-01-01T00:00:00.000Z" }));
    expect((await listUpdateOperations(root)).active?.id).toBe(operation.id);
    await expect(reserveUpdateOperation(root, input)).rejects.toMatchObject({ code: "UPDATE_OPERATION_CONFLICT" });
  });

  it("fails closed when a lock exists without its durable operation record", async () => {
    const root = await fixture();
    const operation = await reserveUpdateOperation(root, input);
    await rm(join(root, `${operation.id}.json`));
    await expect(listUpdateOperations(root)).rejects.toThrow(/incomplete.*lock/i);
    await expect(reserveUpdateOperation(root, input)).rejects.toMatchObject({ code: "UPDATE_OPERATION_CONFLICT" });
  });
});
