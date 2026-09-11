import type { Worktree } from "./worktrees";

export interface WorkspaceIdentity {
  state: "loading" | "unknown" | "not-git" | "branch" | "detached";
  sourceCwd: string;
  repository: string;
  branch: string | null;
  root: string;
  isGit: boolean;
  detached: boolean;
}

function trimTrailingSlash(value: string): string {
  value = value.replace(/\\/g, "/");
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function basename(value: string): string {
  const normalized = trimTrailingSlash(value);
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function containsPath(root: string, child: string): boolean {
  const normalizedRoot = trimTrailingSlash(root);
  const normalizedChild = trimTrailingSlash(child);
  return normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}/`);
}

/** Resolve the repository and branch that own a session cwd. */
export function resolveWorkspaceIdentity(cwd: string, worktrees: Worktree[]): WorkspaceIdentity {
  const match = worktrees
    .filter((worktree) => containsPath(worktree.path, cwd))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const root = match?.path ?? cwd;

  return {
    state: match ? (match.branch ? "branch" : "detached") : "not-git",
    sourceCwd: cwd,
    repository: basename(root),
    branch: match?.branch ?? (match?.head ? match.head.slice(0, 7) : null),
    root,
    isGit: Boolean(match),
    detached: Boolean(match && !match.branch),
  };
}

export function pendingWorkspaceIdentity(cwd: string, state: "loading" | "unknown" = "loading"): WorkspaceIdentity {
  return { ...resolveWorkspaceIdentity(cwd, []), state };
}

export function workspaceStateLabel(identity: WorkspaceIdentity): "topbar.gitLoading" | "topbar.gitUnavailable" | "topbar.notGitRepository" {
  return identity.state === "loading" ? "topbar.gitLoading" : identity.state === "unknown" ? "topbar.gitUnavailable" : "topbar.notGitRepository";
}
