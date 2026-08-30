import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { join, dirname, resolve, sep } from "path";
import { tmpdir } from "os";
import { createHash, randomBytes } from "crypto";
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

export interface SnapshotRestoreChange {
  path: string;
  action: "restore" | "remove";
  status: string;
}

export interface SnapshotRestoreImpact {
  total: number;
  restore: number;
  remove: number;
  changes: SnapshotRestoreChange[];
}

export interface SnapshotListItem {
  id: string;
  ts: number;
  label: string;
  /** Historical worktree delta when the snapshot was captured. */
  fileCount: number;
  /** Current files that would actually change if this snapshot were restored. */
  impact: SnapshotRestoreImpact;
}

export interface SnapshotRestoreReview {
  label: string;
  impact: SnapshotRestoreImpact;
  fingerprint: string;
  currentTree: string;
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

/** Parse git's NUL-delimited --name-status output into user-facing restore actions. */
export function parseSnapshotDiff(diff: string): SnapshotRestoreChange[] {
  const parts = diff.split("\0").filter((part) => part.length > 0);
  const changes: SnapshotRestoreChange[] = [];

  for (let index = 0; index < parts.length;) {
    const status = parts[index] ?? "";
    const code = status[0] ?? "";
    const hasTwoPaths = code === "R" || code === "C";
    const firstPath = parts[index + 1];
    const secondPath = hasTwoPaths ? parts[index + 2] : undefined;
    index += hasTwoPaths ? 3 : 2;

    if (!firstPath) continue;
    if (code === "A") {
      changes.push({ path: firstPath, action: "remove", status: code });
      continue;
    }
    if (code === "R") {
      if (secondPath) changes.push({ path: secondPath, action: "remove", status: code });
      changes.push({ path: firstPath, action: "restore", status: code });
      continue;
    }
    if (code === "C") {
      if (secondPath) changes.push({ path: secondPath, action: "remove", status: code });
      continue;
    }
    changes.push({ path: firstPath, action: "restore", status: code });
  }

  return changes;
}

function restoreImpact(diff: string): SnapshotRestoreImpact {
  const allChanges = parseSnapshotDiff(diff);
  const restore = allChanges.filter((change) => change.action === "restore").length;
  const remove = allChanges.length - restore;
  return {
    total: allChanges.length,
    restore,
    remove,
    // Prevent a very large worktree from turning this compact sidebar API into
    // a multi-megabyte response. Counts remain exact and the preview says when
    // the visible list is truncated.
    changes: allChanges.slice(0, 100),
  };
}

export async function listSnapshots(cwd: string, sessionId: string): Promise<SnapshotListItem[]> {
  const snapshots = readMeta(sessionId);
  if (snapshots.length === 0) return [];
  const currentTree = await currentWorkingTree(cwd);
  const items = await Promise.all(snapshots.map(async ({ id, ts, label, fileCount, commit }) => {
    const diff = await git(cwd, ["diff", "--name-status", "-z", commit, currentTree]);
    return { id, ts, label, fileCount, impact: restoreImpact(diff) } satisfies SnapshotListItem;
  }));
  // A restore point that changes nothing is noise and creates false urgency.
  return items.filter((item) => item.impact.total > 0);
}

export async function inspectSnapshotRestore(
  cwd: string,
  sessionId: string,
  id: string,
): Promise<SnapshotRestoreReview> {
  if (!(await isGitRepo(cwd))) throw new Error("not a git repository");
  const meta = readMeta(sessionId).find((snapshot) => snapshot.id === id);
  if (!meta) throw new Error("snapshot not found");
  const currentTree = await currentWorkingTree(cwd);
  const diff = await git(cwd, ["diff", "--name-status", "-z", meta.commit, currentTree]);
  const impact = restoreImpact(diff);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ cwd, sessionId, id, commit: meta.commit, currentTree }))
    .digest("hex");
  return { label: meta.label, impact, fingerprint, currentTree };
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
export async function restoreSnapshot(
  cwd: string,
  sessionId: string,
  id: string,
  expectedCurrentTree?: string,
): Promise<RestoreResult> {
  if (!(await isGitRepo(cwd))) throw new Error("not a git repository");
  const meta = readMeta(sessionId).find((m) => m.id === id);
  if (!meta) throw new Error("snapshot not found");

  const curTree = await currentWorkingTree(cwd);
  if (expectedCurrentTree && curTree !== expectedCurrentTree) {
    throw new Error("working tree changed after restore review");
  }
  const diff = await git(cwd, ["diff", "--name-status", "-z", meta.commit, curTree]);
  const changes = parseSnapshotDiff(diff);
  const result: RestoreResult = { restored: 0, removed: 0, failed: [] };

  for (const change of changes) {
    const { path } = change;
    try {
      if (change.action === "remove") {
        const full = safeJoin(cwd, path);
        if (full && existsSync(full) && statSync(full).isFile()) {
          rmSync(full, { force: true });
          result.removed++;
        }
      } else {
        await git(cwd, ["checkout", meta.commit, "--", path]);
        result.restored++;
      }
    } catch {
      result.failed.push(path);
    }
  }
  return result;
}
