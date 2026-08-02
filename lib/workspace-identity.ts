import type { Worktree } from "./worktrees";

export interface WorkspaceIdentity {
  sourceCwd: string;
  repository: string;
  branch: string | null;
  root: string;
  isGit: boolean;
  detached: boolean;
}

function trimTrailingSlash(value: string): string {
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
    sourceCwd: cwd,
    repository: basename(root),
    branch: match?.branch ?? (match?.head ? match.head.slice(0, 7) : null),
    root,
    isGit: Boolean(match),
    detached: Boolean(match && !match.branch),
  };
}
