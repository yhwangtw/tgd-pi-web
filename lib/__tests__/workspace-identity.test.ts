import { describe, expect, it } from "vitest";
import { resolveWorkspaceIdentity } from "../workspace-identity";

describe("resolveWorkspaceIdentity", () => {
  it("shows the owning repository and branch for a nested session cwd", () => {
    expect(resolveWorkspaceIdentity("/work/demo/src", [
      { path: "/work/demo", branch: "feature/mobile", head: "0123456789", isMain: true },
    ])).toEqual({
      sourceCwd: "/work/demo/src",
      repository: "demo",
      branch: "feature/mobile",
      root: "/work/demo",
      isGit: true,
      detached: false,
    });
  });

  it("uses the linked worktree that most specifically contains the cwd", () => {
    expect(resolveWorkspaceIdentity("/work/demo-wt/packages/app", [
      { path: "/work/demo", branch: "main", head: "aaaaaaaa", isMain: true },
      { path: "/work/demo-wt", branch: "fix/rwd", head: "bbbbbbbb", isMain: false },
    ])).toMatchObject({ repository: "demo-wt", branch: "fix/rwd", root: "/work/demo-wt" });
  });

  it("falls back to the folder name outside git and to a short sha when detached", () => {
    expect(resolveWorkspaceIdentity("/work/plain/", [])).toMatchObject({
      repository: "plain",
      branch: null,
      isGit: false,
      detached: false,
    });
    expect(resolveWorkspaceIdentity("/work/detached", [
      { path: "/work/detached", branch: null, head: "1234567890abcdef", isMain: true },
    ])).toMatchObject({ repository: "detached", branch: "1234567", detached: true });
  });
});
