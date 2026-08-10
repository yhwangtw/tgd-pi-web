import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { join, dirname, resolve, sep } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ============================================================================
// File snapshots — git-backed "restore points" for the working tree.
//
// A snapshot captures the full current working tree (tracked + untracked,
// .gitignore respected) as a real git commit object kept alive under
// refs/pi/snap/<sessionId>/<id>. It never touches the user's index or HEAD:
// staging happens in a throwaway temp index. Restore is precise — it diffs the
// snapshot against the current tree and only reverts the files that changed
// (modified/deleted files restored from the snapshot, files created since the
// snapshot removed), leaving everything else alone.
//
// Only works inside a git repo; callers get null / [] outside one.
// ============================================================================

export interface SnapshotMeta {
  id: string;
  /** git ref keeping the snapshot commit alive */
  ref: string;
  /** snapshot commit sha (used for diff + checkout) */
  commit: string;
  /** snapshot tree sha (used for cheap dedup) */
  tree: string;
  ts: number;
  label: string;
  /** number of files changed vs HEAD at snapshot time (display only) */
  fileCount: number;
}

const MAX_PER_SESSION = 20;
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "pi-web",
  GIT_AUTHOR_EMAIL: "pi-web@local",
  GIT_COMMITTER_NAME: "pi-web",
  GIT_COMMITTER_EMAIL: "pi-web@local",
};

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** A temp index PATH that does not exist yet (git needs to create it fresh). */
function tempIndexPath(): string {
  return join(tmpdir(), `pi-idx-${randomBytes(8).toString("hex")}`);
}

/** Stage the whole current working tree into a throwaway index and write its tree sha. */
async function currentWorkingTree(cwd: string): Promise<string> {
  const idx = tempIndexPath();
  try {
    await git(cwd, ["add", "-A"], { GIT_INDEX_FILE: idx });
    return (await git(cwd, ["write-tree"], { GIT_INDEX_FILE: idx })).trim();
  } finally {
    try { rmSync(idx, { force: true }); } catch { /* ignore */ }
  }
}

function metaPath(sessionId: string): string {
  return join(getAgentDir(), "snapshots", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

function readMeta(sessionId: string): SnapshotMeta[] {
  const p = metaPath(sessionId);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { snapshots?: SnapshotMeta[] };
    return Array.isArray(raw.snapshots) ? raw.snapshots : [];
  } catch {
    return [];
  }
}

function writeMeta(sessionId: string, snapshots: SnapshotMeta[]): void {
  const p = metaPath(sessionId);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ snapshots }, null, 2), "utf8");
}

/**
 * Snapshot the working tree. Returns the new (or, if the tree is unchanged
 * since the latest snapshot, the existing) metadata — or null outside a repo.
 */
export async function createSnapshot(cwd: string, sessionId: string, label: string): Promise<SnapshotMeta | null> {
  if (!(await isGitRepo(cwd))) return null;

  const tree = await currentWorkingTree(cwd);
  const existing = readMeta(sessionId);
  // Dedup: no file changed since the last snapshot → nothing to capture.
  if (existing[0]?.tree === tree) return existing[0];

  const head = await git(cwd, ["rev-parse", "HEAD"]).then((s) => s.trim()).catch(() => "");
  const commitArgs = head ? ["commit-tree", tree, "-p", head, "-m", "pi-snapshot"] : ["commit-tree", tree, "-m", "pi-snapshot"];
  const commit = (await git(cwd, commitArgs, GIT_IDENTITY)).trim();

  const id = randomBytes(6).toString("hex");
  const ref = `refs/pi/snap/${sessionId.replace(/[^\w.-]/g, "_")}/${id}`;
  await git(cwd, ["update-ref", ref, commit]);

  let fileCount = 0;
  try {
    const out = head
      ? await git(cwd, ["diff", "--name-only", head, tree])
      : await git(cwd, ["ls-tree", "-r", "--name-only", tree]);
    fileCount = out.split("\n").filter((l) => l.trim()).length;
  } catch { /* best-effort */ }

  const meta: SnapshotMeta = { id, ref, commit, tree, ts: Date.now(), label, fileCount };
  const next = [meta, ...existing];

  // Prune beyond the cap, deleting the backing refs so git can GC them.
  const keep = next.slice(0, MAX_PER_SESSION);
  for (const old of next.slice(MAX_PER_SESSION)) {
    await git(cwd, ["update-ref", "-d", old.ref]).catch(() => {});
  }
  writeMeta(sessionId, keep);
  return meta;
}

export function listSnapshots(sessionId: string): Omit<SnapshotMeta, "ref" | "commit" | "tree">[] {
  return readMeta(sessionId).map(({ id, ts, label, fileCount }) => ({ id, ts, label, fileCount }));
}

export async function readSnapshotFile(cwd: string, sessionId: string, id: string, relPath: string): Promise<string> {
  if (!safeJoin(cwd, relPath) || relPath.startsWith("-")) throw new Error("path not allowed");
  const meta = readMeta(sessionId).find((snapshot) => snapshot.id === id);
  if (!meta) throw new Error("snapshot not found");
  return git(cwd, ["show", `${meta.commit}:${relPath.split(sep).join("/")}`]);
}

export interface RestoreResult {
  restored: number;
  removed: number;
  failed: string[];
}

/** Return the resolved path if `rel` stays inside `cwd`, else null. */
function safeJoin(cwd: string, rel: string): string | null {
  const full = resolve(cwd, rel);
  const base = resolve(cwd);
  if (full === base || full.startsWith(base + sep)) return full;
  return null;
}

/**
 * Revert the working tree to a snapshot, touching only the files that differ:
 * modified/deleted files are restored from the snapshot, files created since
 * the snapshot are removed. Unrelated files are left untouched.
 */
export async function restoreSnapshot(cwd: string, sessionId: string, id: string): Promise<RestoreResult> {
  if (!(await isGitRepo(cwd))) throw new Error("not a git repository");
  const meta = readMeta(sessionId).find((m) => m.id === id);
  if (!meta) throw new Error("snapshot not found");

  const curTree = await currentWorkingTree(cwd);
  const diff = await git(cwd, ["diff", "--name-status", "-z", meta.commit, curTree]);

  // -z output: STATUS \0 PATH \0 STATUS \0 PATH \0 …  (rename = STATUS \0 OLD \0 NEW)
  const parts = diff.split("\0").filter((s) => s.length > 0);
  const result: RestoreResult = { restored: 0, removed: 0, failed: [] };

  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    const code = status[0];
    // Renames/copies carry two paths; treat the destination as "created after".
    const isRename = code === "R" || code === "C";
    const path = isRename ? parts[i + 2] : parts[i + 1];
    i += isRename ? 3 : 2;
    if (!path) continue;

    try {
      if (code === "A" || isRename) {
        // Present now, absent in the snapshot → remove it.
        const full = safeJoin(cwd, path);
        if (full && existsSync(full) && statSync(full).isFile()) {
          rmSync(full, { force: true });
          result.removed++;
        }
        // A rename also leaves the OLD path missing → restore it below.
        if (isRename) {
          await git(cwd, ["checkout", meta.commit, "--", parts[i - 2]]);
          result.restored++;
        }
      } else {
        // Modified (M) or deleted-since (D) → restore from the snapshot.
        await git(cwd, ["checkout", meta.commit, "--", path]);
        result.restored++;
      }
    } catch {
      result.failed.push(path);
    }
  }
  return result;
}
