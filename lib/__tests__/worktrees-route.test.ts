import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorktrees: vi.fn(async (cwd: string) => [{ path: cwd, head: "abcdef012345", branch: cwd.endsWith("/alpha") ? "main" : "release", isMain: true }]),
}));

vi.mock("@/lib/file-security", () => ({
  getAllowedRoots: vi.fn(async () => new Set(["/work/alpha", "/work/beta"])),
  isPathAllowed: vi.fn((cwd: string, roots: Set<string>) => roots.has(cwd)),
}));

vi.mock("@/lib/worktrees", () => ({ listWorktrees: mocks.listWorktrees }));

import { POST } from "../../app/api/worktrees/route";

function request(cwds: unknown[]) {
  return new Request("http://localhost/api/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwds }),
  });
}

afterEach(() => {
  mocks.listWorktrees.mockClear();
  globalThis.__piWorkspaceIdentityCache?.clear();
});

describe("workspace identity batch route", () => {
  it("deduplicates allowed paths and returns repo/branch labels", async () => {
    const response = await POST(request(["/work/alpha", "/work/alpha", "/work/beta"]));
    expect(response.status).toBe(200);
    const payload = await response.json() as { identities: Record<string, { repository: string; branch: string }> };
    expect(payload.identities["/work/alpha"]).toMatchObject({ repository: "alpha", branch: "main" });
    expect(payload.identities["/work/beta"]).toMatchObject({ repository: "beta", branch: "release" });
    expect(mocks.listWorktrees).toHaveBeenCalledTimes(2);
  });

  it("rejects any path outside the session allowlist", async () => {
    const response = await POST(request(["/work/alpha", "/private/secret"]));
    expect(response.status).toBe(403);
    expect(mocks.listWorktrees).not.toHaveBeenCalled();
  });
});
