import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { realpath } from "fs/promises";

const execFileAsync = promisify(execFile);

export interface Worktree {
  path: string;
  /** Branch name without refs/heads/, or null when detached. */
  branch: string | null;
  head: string | null;
  /** First entry in porcelain output = the main checkout. */
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain` output. Blocks are separated by blank
 * lines; each has `worktree <path>`, `HEAD <sha>`, and `branch <ref>` or
 * `detached`, plus optional `locked`/`prunable` annotations.
 */
export function parseWorktreePorcelain(out: string): (Worktree & { prunable: boolean })[] {
  // -z preserves literal Unicode, quotes and newlines in directory names.
  // Retain newline parsing for older callers and fixture snapshots.
  const nul = out.includes("\0");
  const blocks = nul ? out.split("\0\0").filter(Boolean) : out.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const result: (Worktree & { prunable: boolean })[] = [];
  for (const block of blocks) {
    let path = "";
    let branch: string | null = null;
    let head: string | null = null;
    let prunable = false;
    for (const line of block.split(nul ? "\0" : "\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") branch = null;
      else if (line.startsWith("prunable")) prunable = true;
    }
    if (path) result.push({ path, branch, head, isMain: result.length === 0, prunable });
  }
  return result;
}

/**
 * List a repo's worktrees (main checkout first). Prunable or missing-on-disk
 * entries are dropped — Git happily reports checkouts whose directories are
 * gone, and offering those as switch targets would only produce errors.
 * Returns [] for non-git dirs.
 */
export interface WorktreeState {
  state: "ready" | "not-git" | "unknown";
  canonicalCwd: string;
  worktrees: Worktree[];
}

/** Unlike listWorktrees, preserve failures so UI never reports them as non-Git. */
export async function readWorktreeState(cwd: string): Promise<WorktreeState> {
  let canonicalCwd = cwd;
  try {
    canonicalCwd = await realpath(cwd);
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: canonicalCwd,
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const worktrees = parseWorktreePorcelain(stdout)
      .filter((w) => !w.prunable && existsSync(w.path))
      .map(({ prunable: _prunable, ...w }) => w);
    return { state: "ready", canonicalCwd, worktrees };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return { state: /fatal: not a git repository/.test(stderr) ? "not-git" : "unknown", canonicalCwd, worktrees: [] };
  }
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  return (await readWorktreeState(cwd)).worktrees;
}
