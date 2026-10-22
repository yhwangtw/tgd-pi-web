import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ list: vi.fn(), tgd: vi.fn(), agent: "/fixture/agent-a", home: "/fixture/home", readdir: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => harness.agent }));
vi.mock("../session-reader", () => ({ listAllSessions: harness.list }));
vi.mock("../tgd-artifacts", () => ({ resolveTgdDir: harness.tgd }));
vi.mock("node:os", () => ({ homedir: () => harness.home }));
vi.mock("node:fs/promises", async actual => ({ ...await actual<typeof import("node:fs/promises")>(), readdir: harness.readdir }));
import { getAllowedRoots, registerSelectedWorkspace } from "../file-security";

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  harness.agent = "/fixture/agent-a";
  harness.list.mockReset().mockResolvedValue([{ cwd: "/workspace" }, { cwd: "/workspace" }, { cwd: "/other" }]);
  harness.tgd.mockReset().mockImplementation((cwd: string) => `${cwd}-tGD`);
  harness.readdir.mockReset().mockResolvedValue(["pi-cwd-20261022", "unrelated"]);
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piAllowedRootsPending = undefined;
  globalThis.__piSelectedWorkspaceRoots = undefined;
  globalThis.__piSelectedWorkspaceScope = undefined;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("allowed workspace root index", () => {
  it("coalesces concurrent misses and resolves artifacts once per distinct cwd", async () => {
    const roots = await Promise.all(Array.from({ length: 24 }, () => getAllowedRoots()));
    expect(harness.list).toHaveBeenCalledTimes(1);
    expect(harness.tgd).toHaveBeenCalledTimes(2);
    expect(harness.readdir).toHaveBeenCalledTimes(1);
    expect(roots[0]).toEqual(new Set(["/workspace", "/other", "/workspace-tGD", "/other-tGD", "/fixture/home/pi-cwd-20261022"]));
    roots[0].add("/not-authorized");
    expect((await getAllowedRoots()).has("/not-authorized")).toBe(false);
    expect(harness.list).toHaveBeenCalledTimes(1);
  });

  it("merges newly selected workspaces into an in-flight or warm index without another session scan", async () => {
    let complete!: (sessions: Array<{ cwd: string }>) => void;
    harness.list.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const first = getAllowedRoots();
    registerSelectedWorkspace("/new-selection");
    complete([{ cwd: "/workspace" }]);
    expect((await first).has("/new-selection")).toBe(true);
    registerSelectedWorkspace("/second-selection");
    expect((await getAllowedRoots()).has("/second-selection")).toBe(true);
    globalThis.__piSelectedWorkspaceRoots!.delete("/new-selection");
    expect((await getAllowedRoots()).has("/new-selection")).toBe(false);
    expect(harness.list).toHaveBeenCalledTimes(1);
  });

  it("keeps five-second revocation freshness and isolates changed agent directories", async () => {
    registerSelectedWorkspace("/selected-a");
    expect((await getAllowedRoots()).has("/workspace")).toBe(true);
    harness.list.mockResolvedValue([]);
    vi.setSystemTime(15_001);
    const expired = await getAllowedRoots();
    expect(expired.has("/workspace")).toBe(false);
    expect(harness.list).toHaveBeenCalledTimes(2);
    harness.agent = "/fixture/agent-b";
    expect((await getAllowedRoots()).has("/selected-a")).toBe(false);
    expect(harness.list).toHaveBeenCalledTimes(3);
  });

  it("does not retain a failed scan and retries safely", async () => {
    harness.list.mockRejectedValueOnce(new Error("index unavailable"));
    await expect(getAllowedRoots()).rejects.toThrow("index unavailable");
    expect((await getAllowedRoots()).has("/workspace")).toBe(true);
    expect(harness.list).toHaveBeenCalledTimes(2);
  });
});
