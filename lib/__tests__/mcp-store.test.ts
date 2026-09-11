import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { deleteMcpServer, readMcpServers, saveMcpServer, validateMcpServer } from "../mcp";

const filename = () => join(getAgentDir(), "mcp-servers.json");
const seed = (id: string) => ({ id, name: id, enabled: false, transport: "http" as const, scope: "global" as const, url: "https://example.test/mcp" });
const invalidated = vi.fn(async () => {});
let child: ChildProcess | undefined;
beforeEach(async () => {
  await fs.rm(filename(), { force: true });
  globalThis.__piMcpManager = { invalidate: invalidated } as never;
  invalidated.mockReset();
});
afterEach(async () => {
  globalThis.__piMcpManager = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  child = undefined;
});

describe("MCP versioned configuration store", () => {
  it("rejects stale or unversioned edits and keeps the successful update", async () => {
    const initial = await saveMcpServer(seed("remote"));
    expect(initial.revision).toEqual(expect.any(String));
    expect((await readMcpServers())[0].revision).toBe(initial.revision);
    const saved = await saveMcpServer({ ...initial, name: "New name" });
    expect(saved.revision).not.toBe(initial.revision);
    await expect(saveMcpServer({ ...initial, timeoutMs: 2000 })).rejects.toMatchObject({ status: 409 });
    await expect(saveMcpServer({ id: initial.id, name: "Missing revision" })).rejects.toMatchObject({ status: 428 });
    expect((await readMcpServers())[0]).toEqual(saved);
    expect(invalidated).toHaveBeenCalledTimes(2);
  });
  it("does not silently lose concurrent creates; rejected changes can be retried", async () => {
    const inputs = Array.from({ length: 8 }, (_, index) => seed(`parallel-${index}`));
    const results = await Promise.allSettled(inputs.map(input => saveMcpServer(input)));
    const successful = results.flatMap(result => result.status === "fulfilled" ? [result.value.id] : []);
    expect(successful.length).toBeGreaterThan(0);
    expect((await readMcpServers()).map(server => server.id).sort()).toEqual([...successful].sort());
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ status: 409 });
        await saveMcpServer(inputs[index]);
      }
    }
    expect(await readMcpServers()).toHaveLength(8);
  });
  it("uses the same OS-backed lock as another cooperating process", async () => {
    const initial = await saveMcpServer(seed("locked"));
    const agentDirectory = await fs.realpath(getAgentDir());
    child = fork(new URL("./fixtures/file-mutation-worker.mjs", import.meta.url), [join(agentDirectory, "file-mutation-locks"), await fs.realpath(filename())], {
      execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const first = await Promise.race([once(child, "message").then(([message]) => message), once(child, "exit").then(() => { throw new Error("Lock holder exited early"); })]);
    expect(first).toEqual({ type: "locked" });
    const before = await fs.readFile(filename(), "utf8");
    await expect(saveMcpServer({ ...initial, name: "Must not save" })).rejects.toMatchObject({ status: 409 });
    await expect(deleteMcpServer(initial.id, initial.revision)).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(filename(), "utf8")).toBe(before);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect((await saveMcpServer({ ...initial, name: "Recovered" })).name).toBe("Recovered");
  });
  it("requires a matching revision for delete and cannot resurrect a deleted edit", async () => {
    const first = await saveMcpServer(seed("delete"));
    const second = await saveMcpServer({ ...first, name: "Updated" });
    await expect(deleteMcpServer(first.id, first.revision)).rejects.toMatchObject({ status: 409 });
    await expect(deleteMcpServer(first.id)).rejects.toMatchObject({ status: 428 });
    expect(await deleteMcpServer(second.id, second.revision)).toBe(true);
    await expect(saveMcpServer({ ...second, name: "Resurrection" })).rejects.toMatchObject({ status: 409 });
    const recreated = await saveMcpServer(seed("delete"));
    expect(recreated.revision).not.toBe(second.revision);
    await expect(deleteMcpServer(second.id, second.revision)).rejects.toMatchObject({ status: 409 });
  });
  it("shows all legacy records above 50 and refuses new records instead of truncating", async () => {
    const servers = Array.from({ length: 51 }, (_, index) => validateMcpServer(seed(`legacy-${index}`)));
    await fs.writeFile(filename(), JSON.stringify({ version: 1, servers }));
    const listed = await readMcpServers();
    expect(listed).toHaveLength(51);
    const before = await fs.readFile(filename(), "utf8");
    await expect(saveMcpServer(seed("new-over-limit"))).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(filename(), "utf8")).toBe(before);
    await saveMcpServer({ ...listed[50], name: "Preserved last entry" });
    expect(await readMcpServers()).toHaveLength(51);
    expect((await readMcpServers())[50].name).toBe("Preserved last entry");
  });
  it("detects manual edits even when stored revision and timestamps are retained", async () => {
    const server = await saveMcpServer(seed("manual"));
    const document = JSON.parse(await fs.readFile(filename(), "utf8"));
    document.servers[0].url = "https://changed.example.test/mcp";
    await fs.writeFile(filename(), JSON.stringify(document));
    await expect(saveMcpServer({ ...server, name: "Stale" })).rejects.toMatchObject({ status: 409 });
    expect((await readMcpServers())[0].url).toBe("https://changed.example.test/mcp");
  });
  it.each(["{}", '{"version":2,"servers":[]}', '{"version":1,"servers":{}}', '{"version":1,"servers":[],"futureMetadata":true}', "not JSON"])("never overwrites a malformed or future configuration: %s", async contents => {
    await fs.writeFile(filename(), contents);
    await expect(saveMcpServer(seed("wrong"))).rejects.toThrow();
    expect(await fs.readFile(filename(), "utf8")).toBe(contents);
  });
  it("refuses symlink targets and writes private files without abandoned temporary files", async () => {
    const target = join(getAgentDir(), "untouched.json");
    await fs.writeFile(target, "private original");
    await fs.symlink(target, filename());
    await expect(saveMcpServer(seed("linked"))).rejects.toMatchObject({ status: 403 });
    expect(await fs.readFile(target, "utf8")).toBe("private original");
    await fs.unlink(filename());
    const saved = await saveMcpServer(seed("private"));
    if (process.platform !== "win32") expect((await fs.stat(filename())).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(getAgentDir())).filter(name => name.endsWith(".tmp"))).toEqual([]);
    expect(saved.revision).toBe((await readMcpServers())[0].revision);
  });
  it("requires explicit local-command approval inside the saved transaction", async () => {
    await expect(saveMcpServer({ id: "local", name: "Local", enabled: true, command: "node" })).rejects.toMatchObject({ status: 400 });
    expect(await readMcpServers()).toEqual([]);
    expect((await saveMcpServer({ id: "local", name: "Local", enabled: true, command: "node" }, { trustStdio: true })).enabled).toBe(true);
  });
  it("does not create or rewrite configuration for an absent unversioned deletion", async () => {
    expect(await deleteMcpServer("absent")).toBe(false);
    await expect(fs.stat(filename())).rejects.toMatchObject({ code: "ENOENT" });
    await saveMcpServer(seed("untouched"));
    const before = await fs.stat(filename());
    const contents = await fs.readFile(filename(), "utf8");
    expect(await deleteMcpServer("absent")).toBe(false);
    expect((await fs.stat(filename())).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(filename(), "utf8")).toBe(contents);
    expect(invalidated).toHaveBeenCalledTimes(1);
  });
  it.each(["", "../escape", 7, null])("rejects invalid delete id %s without writing", async id => {
    await expect(deleteMcpServer(id as string)).rejects.toMatchObject({ status: 400 });
    await expect(fs.stat(filename())).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps per-record revisions stable across reads and unrelated updates", async () => {
    await fs.writeFile(filename(), JSON.stringify({ version: 1, servers: [seed("legacy"), seed("other")] }));
    const first = await readMcpServers();
    expect(await readMcpServers()).toEqual(first);
    await saveMcpServer({ ...first[1], name: "Other changed" });
    expect((await readMcpServers())[0]).toEqual(first[0]);
    expect((await saveMcpServer({ ...first[0], name: "Legacy changed" })).createdAt).toBe(first[0].createdAt);
  });
  it("reports cleanup separately after the committed configuration is readable", async () => {
    const warning = vi.fn();
    invalidated.mockRejectedValueOnce(new Error("cleanup unavailable"));
    const saved = await saveMcpServer(seed("committed"), { onCleanupError: warning });
    expect(await readMcpServers()).toEqual([saved]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("configuration was saved"));
  });
  it("rejects the 51st create but allows adding again after a versioned deletion", async () => {
    await fs.writeFile(filename(), JSON.stringify({ version: 1, servers: Array.from({ length: 50 }, (_, i) => seed(`cap-${i}`)) }));
    await expect(saveMcpServer(seed("over"))).rejects.toMatchObject({ status: 409 });
    const first = (await readMcpServers())[0];
    await deleteMcpServer(first.id, first.revision);
    await saveMcpServer(seed("replacement"));
    expect(await readMcpServers()).toHaveLength(50);
  });
  it("rejects duplicate legacy ids and oversized documents without replacing them", async () => {
    const duplicate = JSON.stringify({ version: 1, servers: [seed("same"), seed("same")] });
    await fs.writeFile(filename(), duplicate);
    await expect(readMcpServers()).rejects.toMatchObject({ status: 503 });
    await expect(saveMcpServer(seed("new"))).rejects.toThrow();
    expect(await fs.readFile(filename(), "utf8")).toBe(duplicate);
    const large = JSON.stringify({ version: 1, servers: [] }) + " ".repeat(4 * 1024 * 1024);
    await fs.writeFile(filename(), large);
    await expect(saveMcpServer(seed("new"))).rejects.toThrow();
    expect(await fs.readFile(filename(), "utf8")).toBe(large);
  });
  it.each([
    { enabled: "false" }, { scope: null }, { transport: "sse" }, { timeoutMs: "15000" }, { timeoutMs: 1000.1 },
    { args: [3] }, { args: Array(65).fill("a") }, { args: ["a\0b"] }, { args: ["a".repeat(8193)] },
    { cwd: "relative" }, { name: "n".repeat(81) }, { id: "Bad id" }, { unknownField: true },
    { url: "https://user:password@example.test/mcp" }, { url: "file:///tmp/mcp" },
    { headers: [] }, { headers: { "Bad header": "value" } }, { headers: { A: "a", a: "b" } },
    { headers: { A: 3 } }, { headers: { A: "a\r\nb" } }, { headers: { Authorization: "literal ${TOKEN}" + "suffix" } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, "value"])) },
  ])("rejects invalid input without silently coercing or truncating: %j", async invalid => {
    await saveMcpServer(seed("existing"));
    const before = await fs.readFile(filename(), "utf8");
    await expect(saveMcpServer({ ...seed("invalid"), ...invalid } as never)).rejects.toMatchObject({ status: 400 });
    expect(await fs.readFile(filename(), "utf8")).toBe(before);
  });
  it("preserves exact argument strings and environment-backed headers", async () => {
    const args = ["", "  padded  ", "line1\nline2"];
    const headers = { Authorization: "Bearer ${MCP_TOKEN}", "X-Api-Key": "${OTHER_TOKEN}" };
    const saved = await saveMcpServer({ ...seed("exact"), args, headers });
    expect(saved.args).toEqual(args);
    expect(saved.headers).toEqual(headers);
    expect(await readMcpServers()).toEqual([saved]);
  });
});
