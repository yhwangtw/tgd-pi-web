import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ roots: new Set<string>(), skills: [] as Array<{ filePath: string }>, trusted: false, sessionCwd: "", loaderOptions: vi.fn(), executions: vi.fn() }));
vi.mock("../file-security", async actual => ({ ...await actual<typeof import("../file-security")>(), getAllowedRoots: async () => state.roots }));
vi.mock("@earendil-works/pi-coding-agent", async actual => ({
  ...await actual<typeof import("@earendil-works/pi-coding-agent")>(),
  DefaultResourceLoader: class { constructor(options: unknown) { state.loaderOptions(options); } async reload() {} getSkills() { return { skills: state.skills, diagnostics: [] }; } },
}));
vi.mock("../rpc-manager", () => ({ getRpcSession: () => ({ isAlive: () => true, cwd: state.sessionCwd, inner: { settingsManager: { isProjectTrusted: () => state.trusted } } }) }));
vi.mock("../durable-chat", () => ({ getDurableChat: () => undefined }));
vi.mock("child_process", () => ({ execFile: (...args: unknown[]) => {
  state.executions(...args.slice(0, -1));
  (args.at(-1) as (err: unknown, result: unknown) => void)(null, { stdout: "[]", stderr: "" });
} }));
import { GET as skillsGet, PATCH as skillsPatch } from "../../app/api/skills/route";
import { GET as insights } from "../../app/api/files/insights/route";
import { GET as semantic } from "../../app/api/search/semantic/route";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let base: string, root: string, outside: string, skill: string;
const request = (route: string, params: Record<string, string>, signal?: AbortSignal) => new Request(`http://localhost${route}?${new URLSearchParams({ sessionId: "fixture", ...params })}`, { signal });
const toggle = (extra: object = {}) => skillsPatch(new Request("http://localhost/api/skills", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: root, filePath: skill, disableModelInvocation: true, ...extra }) }));
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pi-boundary-audit-"));
  root = join(base, "workspace"); outside = join(base, "global-skills");
  await mkdir(root); await mkdir(outside);
  skill = join(outside, "SKILL.md");
  await writeFile(skill, "---\nname: example\ndescription: example\n---\nKeep this body.\n");
  await writeFile(join(root, "file.ts"), "const hello = 1;");
  state.roots = new Set([root]); state.skills = [{ filePath: skill }]; state.trusted = false; state.sessionCwd = root; state.loaderOptions.mockClear(); state.executions.mockClear();
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("skill route authorization and atomic writes", () => {
  it("edits a discovered global skill without restricting it to the workspace", async () => {
    expect((await toggle()).status).toBe(200);
    expect(state.loaderOptions).toHaveBeenCalledWith(expect.objectContaining({ noExtensions: true }));
    expect(await readFile(skill, "utf8")).toContain("disable-model-invocation: true");
    expect((await toggle({ disableModelInvocation: false })).status).toBe(200);
    expect(await readFile(skill, "utf8")).not.toContain("disable-model-invocation");
    expect(await (await skillsGet(request("/api/skills", { cwd: root, content: skill }))).json()).toEqual({ content: "Keep this body." });
  });
  it("rejects unknown files, invalid booleans and an unauthorized workspace without modifying content", async () => {
    const original = await readFile(skill, "utf8");
    expect((await toggle({ filePath: join(root, "file.ts") })).status).toBe(403);
    expect((await toggle({ disableModelInvocation: "true" })).status).toBe(400);
    expect((await toggle({ cwd: outside })).status).toBe(403);
    expect((await skillsGet(request("/api/skills", { cwd: outside }))).status).toBe(403);
    expect(await readFile(skill, "utf8")).toBe(original);
  });
  it("rejects a discovered file symlink and reserved internal files", async () => {
    const alias = join(outside, "alias.md"); await symlink(skill, alias); state.skills.push({ filePath: alias });
    expect((await toggle({ filePath: alias })).status).toBe(403);
    const reserved = join(getAgentDir(), "models-config-backups", "SKILL.md");
    await mkdir(join(getAgentDir(), "models-config-backups"), { recursive: true }); await writeFile(reserved, "secret");
    state.skills.push({ filePath: reserved });
    expect((await toggle({ filePath: reserved })).status).toBe(403);
    expect(await readFile(reserved, "utf8")).toBe("secret");
  });
});

describe("insights execution boundary", () => {
  it("never runs project binaries before the workspace is trusted", async () => {
    for (const mode of ["diagnostics", "tests"]) expect((await insights(request("/api/files/insights", { cwd: root, path: "file.ts", mode }))).status).toBe(403);
    expect(state.executions).not.toHaveBeenCalled();
  });
  it("passes cancellation to trusted execution and rejects traversal and symlink files", async () => {
    state.trusted = true;
    const controller = new AbortController();
    expect((await insights(request("/api/files/insights", { cwd: root, path: "file.ts", mode: "diagnostics" }, controller.signal))).status).toBe(200);
    expect(state.executions).toHaveBeenCalledTimes(2);
    expect(state.executions.mock.calls.every(call => call[2].signal instanceof AbortSignal)).toBe(true);
    await symlink(skill, join(root, "alias.ts"));
    for (const path of ["alias.ts", "../global-skills/SKILL.md"]) expect((await insights(request("/api/files/insights", { cwd: root, path, mode: "diagnostics" }))).status).toBe(403);
    controller.abort();
    expect((await insights(request("/api/files/insights", { cwd: root, path: "file.ts", mode: "tests" }, controller.signal))).status).toBe(499);
    expect(state.executions).toHaveBeenCalledTimes(2);
  });
});

it("does not execute without the current matching trusted session", async () => {
  state.trusted = true;
  expect((await insights(request("/api/files/insights", { cwd: root, path: "file.ts", mode: "diagnostics", sessionId: "" }))).status).toBe(403);
  state.sessionCwd = outside;
  expect((await insights(request("/api/files/insights", { cwd: root, path: "file.ts", mode: "tests" }))).status).toBe(403);
  expect(state.executions).not.toHaveBeenCalled();
});

describe("semantic file boundary", () => {
  it("rejects symlink roots escaping the authorized workspace", async () => {
    await symlink(outside, join(root, "escape"));
    expect((await semantic(request("/api/search/semantic", { cwd: join(root, "escape"), q: "example" }))).status).toBe(403);
  });
  it("obeys ignores, skips file aliases and reads bounded prefixes of large files", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(join(root, "ignored.ts"), "needle ignored");
    await symlink(skill, join(root, "linked.md"));
    await writeFile(join(root, "large.ts"), "needle searchable " + "x".repeat(2 * 1024 * 1024));
    const response = await semantic(request("/api/search/semantic", { cwd: root, q: "needle" }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.hits.some((hit: { path?: string }) => hit.path?.endsWith("large.ts"))).toBe(true);
    expect(result.hits.some((hit: { path?: string }) => /ignored|linked/.test(hit.path ?? ""))).toBe(false);
  });
});
