import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "../worktrees";

const mocks = vi.hoisted(() => ({
  readWorktreeState: vi.fn(async (cwd: string): Promise<WorktreeState> => ({ state: "ready", canonicalCwd: cwd,
    worktrees: [{ path: cwd, head: "abcdef012345", branch: cwd.endsWith("/alpha") ? "main" : "release", isMain: true }] })),
}));

vi.mock("@/lib/file-security", () => ({
  getAllowedRoots: vi.fn(async () => new Set(["/work/alpha", "/work/beta"])),
  isPathAllowed: vi.fn((cwd: string, roots: Set<string>) => roots.has(cwd)),
}));

vi.mock("@/lib/worktrees", () => ({ readWorktreeState: mocks.readWorktreeState }));

import { GET, POST } from "../../app/api/worktrees/route";

function request(cwds: unknown[]) {
  return new Request("http://localhost/api/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwds }),
  });
}

afterEach(() => {
  mocks.readWorktreeState.mockClear();
  globalThis.__piWorkspaceIdentityCache?.clear();
});

describe("workspace identity batch route", () => {
  it("deduplicates allowed paths and returns repo/branch labels", async () => {
    const response = await POST(request(["/work/alpha", "/work/alpha", "/work/beta"]));
    expect(response.status).toBe(200);
    const payload = await response.json() as { identities: Record<string, { repository: string; branch: string }> };
    expect(payload.identities["/work/alpha"]).toMatchObject({ repository: "alpha", branch: "main" });
    expect(payload.identities["/work/beta"]).toMatchObject({ repository: "beta", branch: "release" });
    expect(mocks.readWorktreeState).toHaveBeenCalledTimes(2);
  });

  it("rejects any path outside the session allowlist", async () => {
    const response = await POST(request(["/work/alpha", "/private/secret"]));
    expect(response.status).toBe(403);
    expect(mocks.readWorktreeState).not.toHaveBeenCalled();
  });

  it("uses canonical paths without changing the requested identity key", async () => {
    mocks.readWorktreeState.mockResolvedValueOnce({ state: "ready", canonicalCwd: "/private/work/alpha/src", worktrees: [
      { path: "/private/work/alpha", head: "abcdef012345", branch: "main", isMain: true },
    ] });
    const response = await GET(new Request("http://localhost/api/worktrees?cwd=/work/alpha"));
    expect((await response.json()).identity).toMatchObject({ state: "branch", sourceCwd: "/work/alpha", root: "/private/work/alpha", repository: "alpha", branch: "main" });
    expect(mocks.readWorktreeState).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "not-git"] as const)("preserves %s instead of conflating failures with non-Git", async (state) => {
    mocks.readWorktreeState.mockResolvedValueOnce({ state, canonicalCwd: "/work/alpha", worktrees: [] });
    const response = await POST(request(["/work/alpha"]));
    expect((await response.json()).identities["/work/alpha"].state).toBe(state);
  });
});
