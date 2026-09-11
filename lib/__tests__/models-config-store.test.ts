import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readModelsConfig, saveModelsConfig, validateModelsConfig, modelsConfigBackupDirectory } from "../models-config-store";
import { isPathAllowed } from "../file-security";
import { isFileMutationLockPath } from "../file-mutation-lock";
import { PUT as putModelsConfig } from "../../app/api/models-config/route";

const injected = vi.hoisted(() => ({
  stage: null as "backup-write" | "backup-rename" | "config-write" | "config-rename" | "config-read" | "config-final-read" | null,
  hits: 0,
  committed: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const failure = (code: string) => Object.assign(new Error(`${code}: synthetic private-fixture-key`), { code });
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      if ((injected.stage === "config-read" || (injected.stage === "config-final-read" && injected.committed)) && target.endsWith("/models.json")) {
        injected.hits += 1;
        throw failure("EACCES");
      }
      const handle = await actual.open(...args);
      const failsWrite = (injected.stage === "backup-write" && /\/models-config-backups\/\.models-.*\.tmp$/.test(target))
        || (injected.stage === "config-write" && /\/\.pi-save-.*\.tmp$/.test(target));
      if (failsWrite) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          // Leave real partial bytes so cleanup is tested, not merely mocked.
          await write("partial fixture bytes", "utf8");
          injected.hits += 1;
          throw failure("EIO");
        };
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const target = String(args[1]);
      if ((injected.stage === "backup-rename" && /\/models-config-backups\/models-.*\.json$/.test(target))
        || (injected.stage === "config-rename" && target.endsWith("/models.json"))) {
        injected.hits += 1;
        throw failure("EACCES");
      }
      const result = await actual.rename(...args);
      if (injected.stage === "config-final-read" && target.endsWith("/models.json")) injected.committed = true;
      return result;
    },
  };
});

const filename = () => join(getAgentDir(), "models.json");
const config = (id = "fixture") => ({ providers: { fixture: { api: "openai-completions", baseUrl: "https://example.test/v1", apiKey: "private-fixture-key", models: [{ id }] } } });
let child: ChildProcess | undefined;
beforeEach(async () => { injected.stage = null; injected.hits = 0; injected.committed = false; await fs.rm(filename(), { force: true }); });
afterEach(async () => {
  injected.stage = null;
  vi.restoreAllMocks();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  child = undefined;
});

describe("models configuration integrity", () => {
  it("returns missing without creating files and requires versioned creates and edits", async () => {
    const missing = await readModelsConfig();
    expect(missing.config).toEqual({ providers: {} });
    expect(missing.revision).toBe("missing");
    expect(missing.path).toBe(filename());
    await expect(fs.stat(filename())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(saveModelsConfig(config())).rejects.toMatchObject({ status: 428 });
    const first = await saveModelsConfig(config(), missing.revision);
    const second = await saveModelsConfig(config("updated"), first.revision);
    expect(second.revision).not.toBe(first.revision);
    await expect(saveModelsConfig(config("stale"), first.revision)).rejects.toMatchObject({ status: 409 });
    expect((await readModelsConfig()).config).toEqual(config("updated"));
  });
  it.each(["private-fixture-key not json", "null", "[]", "{}", '{"providers":[]}', '{"providers":{"bad":{"models":[{"id":4}]}}}'])("fails closed for unreadable configuration syntax/schema: %s", async text => {
    await fs.writeFile(filename(), text);
    await expect(readModelsConfig()).rejects.toMatchObject({ status: 503 });
    await expect(saveModelsConfig(config(), "missing")).rejects.toMatchObject({ status: 503 });
    expect(await fs.readFile(filename(), "utf8")).toBe(text);
  });
  it("preserves supported Pi fields, JSON comments and BOM without executing secret resolvers", async () => {
    const source = { providers: { fixture: {
      name: "Fixture", baseUrl: "https://example.test", api: "custom-api", apiKey: "!never-run-this", oauth: "radius", authHeader: false,
      headers: { Authorization: "ENV_TOKEN" }, compat: { supportsStrictMode: false, chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } },
      models: [{ id: "one", baseUrl: "https://model.test", samplingParams: { temperature: 0.5 }, headers: { "X-Test": "token" }, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }] }, thinkingLevelMap: { max: "max", off: null } }],
      modelOverrides: { builtIn: { name: "Override", cost: { input: 1 }, samplingParams: { temperature: 1 } } },
    } } };
    await fs.writeFile(filename(), `\uFEFF// supported Pi comments\n${JSON.stringify(source)}`);
    const read = await readModelsConfig();
    expect(read.config).toEqual(source);
    await saveModelsConfig(source, read.revision);
    expect((await readModelsConfig()).config).toEqual(source);
  });
  it.each([
    null, [], {}, { providers: [] }, { providers: { p: { models: [{ id: "" }] } } },
    { providers: { p: { models: [{ id: "a" }, { id: "a" }] } } },
    { providers: { p: { headers: { X: 2 } } } }, { providers: { p: { authHeader: "yes" } } },
    { providers: { p: { models: [{ id: "a", maxTokens: -1 }] } } },
    { providers: { p: { models: [{ id: "a", input: ["video"] }] } } },
    { providers: { p: { models: [{ id: "a", thinkingLevelMap: { high: false } }] } } },
    { providers: { p: { models: [{ id: "a", cost: { input: 1 } }] } } },
    { providers: { p: { models: [{ id: "a", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, tiers: [{}] } }] } } },
    { providers: { p: { apiKey: "x".repeat(65_537) } } },
  ])("rejects malformed input without replacing existing data", async value => {
    const initial = await saveModelsConfig(config(), "missing");
    const before = await fs.readFile(filename(), "utf8");
    await expect(saveModelsConfig(value, initial.revision)).rejects.toMatchObject({ status: 400 });
    expect(await fs.readFile(filename(), "utf8")).toBe(before);
  });
  it("keeps bounded unknown Pi extension metadata instead of dropping it", () => {
    const source = { ...config(), extensionMetadata: { enabled: true } };
    expect(validateModelsConfig(source)).toEqual(source);
  });
  it("rejects symlinks and non-regular configuration without changing targets", async () => {
    const target = join(getAgentDir(), "private-target.json");
    await fs.writeFile(target, "untouched secret");
    await fs.symlink(target, filename());
    await expect(readModelsConfig()).rejects.toMatchObject({ status: 403 });
    await expect(saveModelsConfig(config(), "missing")).rejects.toMatchObject({ status: 403 });
    expect(await fs.readFile(target, "utf8")).toBe("untouched secret");
  });
  it("creates private, non-browsable backups before replacement and no abandoned temp files", async () => {
    const first = await saveModelsConfig(config(), "missing");
    const before = await fs.readFile(filename(), "utf8");
    await saveModelsConfig(config("updated"), first.revision);
    const directory = modelsConfigBackupDirectory();
    const files = await fs.readdir(directory);
    const latest = await Promise.all(files.map(async file => ({ file, text: await fs.readFile(join(directory, file), "utf8") })));
    expect(latest.some(file => file.text === before)).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(filename())).mode & 0o777).toBe(0o600);
      for (const file of files) expect((await fs.stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    expect(isPathAllowed(join(directory, files[0]), new Set([getAgentDir()]))).toBe(false);
    expect((await fs.readdir(getAgentDir())).some(file => file.endsWith(".tmp"))).toBe(false);
  });
  it.each(["backup-write", "backup-rename", "config-write", "config-rename", "config-read"] as const)("preserves bytes and revision and removes temporary files after %s fails", async stage => {
    const original = await saveModelsConfig(config(), "missing");
    const bytes = await fs.readFile(filename());
    injected.stage = stage;
    try {
      await expect(saveModelsConfig(config("must-not-save"), original.revision)).rejects.toMatchObject({ status: 503, code: undefined, message: expect.stringContaining("no changes were made") });
      expect(injected.hits).toBe(1);
    } finally {
      injected.stage = null;
    }
    expect(await fs.readFile(filename())).toEqual(bytes);
    expect(await readModelsConfig()).toMatchObject({ revision: original.revision, config: original.config });
    for (const directory of [getAgentDir(), modelsConfigBackupDirectory()]) {
      const files = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      expect(files.filter(file => file.endsWith(".tmp"))).toEqual([]);
    }
    // A failed operation must also relinquish its cooperating mutation lock.
    await expect(saveModelsConfig(config("recovered"), original.revision)).resolves.toMatchObject({ config: config("recovered") });
  });
  it("fails closed on read EACCES without leaking the resolver-like error contents", async () => {
    const original = await saveModelsConfig(config(), "missing");
    const bytes = await fs.readFile(filename());
    injected.stage = "config-read";
    let error: unknown;
    try { await readModelsConfig(); } catch (caught) { error = caught; }
    finally { injected.stage = null; }
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain("private-fixture-key");
    expect(injected.hits).toBe(1);
    expect(await fs.readFile(filename())).toEqual(bytes);
    expect((await readModelsConfig()).revision).toBe(original.revision);
  });
  it("reads a private backup and restores its exact configuration through a fresh versioned save", async () => {
    const original = await saveModelsConfig(config("restore-me"), "missing");
    const bytes = await fs.readFile(filename(), "utf8");
    const directory = modelsConfigBackupDirectory();
    const previous = new Set(await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; }));
    const updated = await saveModelsConfig(config("changed"), original.revision);
    const created = (await fs.readdir(directory)).filter(file => !previous.has(file));
    expect(created).toHaveLength(1);
    const backup = join(directory, created[0]);
    if (process.platform !== "win32") expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
    const backupBytes = await fs.readFile(backup, "utf8");
    expect(backupBytes).toBe(bytes);
    const restored = await saveModelsConfig(JSON.parse(backupBytes), updated.revision);
    expect(restored.config).toEqual(original.config);
    expect(restored.revision).not.toBe(updated.revision);
    expect(restored.revision).not.toBe(original.revision);
    expect(await fs.readFile(filename(), "utf8")).toBe(bytes);
    expect((await readModelsConfig()).revision).toBe(restored.revision);
    await expect(saveModelsConfig(config("stale-after-restore"), updated.revision)).rejects.toMatchObject({ status: 409 });
  });
  it.each(["final-readback", "lock-close"] as const)("reports an unknown save outcome after commit when %s fails without rolling data back", async stage => {
    const original = await saveModelsConfig(config(), "missing");
    const desired = config("committed-update");
    if (stage === "final-readback") injected.stage = "config-final-read";
    else {
      const { DatabaseSync } = await import("node:sqlite");
      const close = DatabaseSync.prototype.close;
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: InstanceType<typeof DatabaseSync>) {
        // Release the real fixture lock, then simulate its error report. No
        // locked handle or process is left behind by the injection.
        close.call(this);
        injected.hits += 1;
        throw Object.assign(new Error("EIO synthetic private-fixture-key"), { code: "EIO" });
      });
    }
    let error: unknown;
    try { await saveModelsConfig(desired, original.revision); } catch (caught) { error = caught; }
    finally { injected.stage = null; vi.restoreAllMocks(); }
    expect(injected.hits).toBe(1);
    expect(error).toMatchObject({ status: 503, code: "save_outcome_unknown" });
    expect(String(error)).toContain("may have completed");
    expect(String(error)).toContain("reload before");
    expect(String(error)).not.toContain("no changes were made");
    expect(String(error)).not.toContain("private-fixture-key");
    const committed = await readModelsConfig();
    expect(committed.config).toEqual(desired);
    expect(committed.revision).not.toBe(original.revision);
    expect(await fs.readFile(filename(), "utf8")).toBe(`${JSON.stringify(desired, null, 2)}\n`);
    for (const directory of [getAgentDir(), modelsConfigBackupDirectory()]) {
      expect((await fs.readdir(directory)).filter(file => file.endsWith(".tmp"))).toEqual([]);
    }
    await expect(saveModelsConfig(config("blind-retry"), original.revision)).rejects.toMatchObject({ status: 409 });
    expect((await readModelsConfig()).config).toEqual(desired);
  });
  it("returns the unknown-outcome HTTP code after a real commit without exposing details or an unverified revision", async () => {
    const original = await saveModelsConfig(config(), "missing");
    const desired = config("http-committed");
    injected.stage = "config-final-read";
    let response: Response;
    try {
      response = await putModelsConfig(new Request("http://localhost/api/models-config", {
        method: "PUT",
        headers: { origin: "http://localhost", "content-type": "application/json", "if-match": `"${original.revision}"` },
        body: JSON.stringify(desired),
      }));
    } finally { injected.stage = null; }
    expect(response.status).toBe(503);
    expect(response.headers.get("etag")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({ code: "save_outcome_unknown" });
    expect(body.error).toContain("may have completed");
    expect(body.error).not.toContain("private-fixture-key");
    expect((await readModelsConfig()).config).toEqual(desired);
  });
  it("serializes against a cooperating external process", async () => {
    const initial = await saveModelsConfig(config(), "missing");
    child = fork(new URL("./fixtures/file-mutation-worker.mjs", import.meta.url), [join(await fs.realpath(getAgentDir()), "file-mutation-locks"), await fs.realpath(filename())], {
      execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const first = await Promise.race([once(child, "message").then(([message]) => message), once(child, "exit").then(() => { throw new Error("Lock holder exited early"); })]);
    expect(first).toEqual({ type: "locked" });
    await expect(saveModelsConfig(config("blocked"), initial.revision)).rejects.toMatchObject({ status: 409 });
    expect((await readModelsConfig()).config).toEqual(config());
  });
  it("detects external edits and competing saves instead of losing an update", async () => {
    const initial = await saveModelsConfig(config(), "missing");
    const results = await Promise.allSettled([saveModelsConfig(config("first"), initial.revision), saveModelsConfig(config("second"), initial.revision)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const fresh = await readModelsConfig();
    await fs.writeFile(filename(), JSON.stringify(config("manual")));
    await expect(saveModelsConfig(config("stale"), fresh.revision)).rejects.toMatchObject({ status: 409 });
    expect((await readModelsConfig()).config).toEqual(config("manual"));
  });
  it("refuses an unsafe backup directory without changing configuration", async () => {
    const initial = await saveModelsConfig(config(), "missing");
    const directory = modelsConfigBackupDirectory();
    const previous = `${directory}-saved`;
    const outside = join(getAgentDir(), "backup-alias-target");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.rename(directory, previous).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.symlink(outside, directory);
    try {
      await expect(saveModelsConfig(config("must-not-save"), initial.revision)).rejects.toMatchObject({ status: 503 });
      expect((await readModelsConfig()).config).toEqual(config());
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.unlink(directory);
      await fs.rename(previous, directory).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  });
  it("reserves backup paths and aliases before creation, including ancestor mutations", async () => {
    const directory = modelsConfigBackupDirectory();
    const alias = join(getAgentDir(), "future-backup-alias");
    await fs.symlink(directory, alias);
    for (const target of [join(directory, "future.json"), join(alias, "future.json")]) {
      expect(isPathAllowed(target, new Set([getAgentDir()]))).toBe(false);
      expect(isFileMutationLockPath(target, getAgentDir())).toBe(true);
    }
    expect(isFileMutationLockPath(getAgentDir(), getAgentDir(), { includeAncestors: true })).toBe(true);
    expect(isPathAllowed(join(getAgentDir(), "ordinary.json"), new Set([getAgentDir()]))).toBe(true);
  });
  it("rejects oversized stored files and deeply nested metadata without replacing them", async () => {
    const oversized = JSON.stringify(config()) + " ".repeat(4 * 1024 * 1024);
    await fs.writeFile(filename(), oversized);
    await expect(readModelsConfig()).rejects.toMatchObject({ status: 413 });
    await expect(saveModelsConfig(config(), "missing")).rejects.toMatchObject({ status: 413 });
    expect(await fs.readFile(filename(), "utf8")).toBe(oversized);
    let nested: unknown = true;
    for (let depth = 0; depth < 22; depth++) nested = { nested };
    expect(() => validateModelsConfig({ ...config(), nested })).toThrow();
  });
});
