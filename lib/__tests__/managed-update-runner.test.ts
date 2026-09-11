import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesRunningIdentity, runManagedOperation, validateIdentityUrl } from "../../scripts/managed-update-runner.mjs";
import { listUpdateOperations, reserveUpdateOperation, writeExpectedUpdateIdentity } from "../../scripts/update-operation-store.mjs";

const roots: string[] = [];
const sha = "a".repeat(40);
const before = { pid: 100, startedAt: "2026-09-07T00:00:00Z" };
const expected = { version: "2026.09.07", sourceSha: sha };
const identity = { pid: 101, startedAt: "2026-09-07T01:00:00Z", build: { ...expected, dirty: false } };
const env = { PIWEB_MANAGED_OPERATION_COMMAND: JSON.stringify({ executable: "/unused/fixture", args: [] }), PIWEB_UPDATE_HEALTH_URL: "http://127.0.0.1:30178/api/runtime/identity", PIWEB_UPDATE_VERIFY_ATTEMPTS: "1" };
async function fixture() { const root = await mkdtemp(join(tmpdir(), "pi-update-runner-")); roots.push(root); return { root, operation: await reserveUpdateOperation(root, { action: "update", cwd: root, expected, before }) }; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("managed update completion evidence", () => {
  it.each([
    "https://external.invalid/api/runtime/identity", "http://127.0.0.1/api/secrets", "http://user:secret@localhost/api/runtime/identity",
  ])("rejects an unsafe health URL %s", url => expect(() => validateIdentityUrl(url)).toThrow());
  it("does not mistake disk changes, an old PID, wrong SHA, or a dirty build for a successful restart", () => {
    expect(matchesRunningIdentity(identity, expected, before)).toBe(true);
    for (const altered of [
      { ...identity, pid: before.pid }, { ...identity, build: { ...identity.build, sourceSha: "b".repeat(40) } },
      { ...identity, build: { ...identity.build, dirty: true } }, { ...identity, build: { version: expected.version } },
    ]) expect(matchesRunningIdentity(altered, expected, before)).toBe(false);
  });
  it("persists success only after helper exit zero and exact new running identity", async () => {
    const { root, operation } = await fixture();
    const execute = vi.fn(async () => ({ code: 0, signal: null }));
    const result = await runManagedOperation(root, operation.id, env, { execute, fetchIdentity: async () => ({ ...identity, cwd: root }) });
    expect(result.status).toBe("succeeded");
    expect(result.verified.build.sourceSha).toBe(sha);
    expect((await listUpdateOperations(root)).active).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  });
  it("persists nonzero helper failure without reading the live service", async () => {
    const { root, operation } = await fixture();
    const fetchIdentity = vi.fn();
    expect((await runManagedOperation(root, operation.id, env, { execute: async () => ({ code: 1 }), fetchIdentity })).status).toBe("failed");
    expect(fetchIdentity).not.toHaveBeenCalled();
  });
  it("does not convert exit zero into success when running readback still shows the old process", async () => {
    const { root, operation } = await fixture();
    expect((await runManagedOperation(root, operation.id, env, {
      execute: async () => ({ code: 0 }), fetchIdentity: async () => ({ ...identity, pid: before.pid }),
    })).status).toBe("verification_failed");
  });
  it("waits for a real fixture child and its durable PID write before finalizing", async () => {
    const { root, operation } = await fixture();
    const childEnv = { ...env, PIWEB_MANAGED_OPERATION_COMMAND: JSON.stringify({ executable: process.execPath, args: ["-e", "process.exit(0)"] }) };
    const result = await runManagedOperation(root, operation.id, childEnv, { fetchIdentity: async () => ({ ...identity, cwd: root }) });
    expect(result).toMatchObject({ status: "succeeded", helperPid: null, exitCode: 0 });
    expect((await listUpdateOperations(root)).recent[0]).toMatchObject({ status: "succeeded", helperPid: null });
  });
  it("rejects matching build identity from a different checkout", async () => {
    const { root, operation } = await fixture();
    expect((await runManagedOperation(root, operation.id, env, {
      execute: async () => ({ code: 0 }), fetchIdentity: async () => ({ ...identity, cwd: tmpdir() }),
    })).status).toBe("verification_failed");
  });
  it("does not allow a published same-version SHA to override the approved source", async () => {
    const { root, operation } = await fixture();
    const replacement = { ...expected, sourceSha: "c".repeat(40) };
    await writeExpectedUpdateIdentity(root, operation.id, replacement);
    const fetchIdentity = vi.fn(async () => ({ ...identity, cwd: root, build: { ...replacement, dirty: false } }));
    expect((await runManagedOperation(root, operation.id, env, { execute: async () => ({ code: 0 }), fetchIdentity })).status).toBe("verification_failed");
    expect(fetchIdentity).not.toHaveBeenCalled();
  });
});
