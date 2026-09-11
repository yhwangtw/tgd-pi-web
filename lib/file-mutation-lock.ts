import * as fs from "node:fs/promises";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class FileMutationLockError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Reserve lock inodes and secret-bearing configuration backups from ordinary
 * file/search APIs, including aliases and destructive ancestor paths.
 * The historical name is kept for existing callers. */
export function isFileMutationLockPath(target: string, agentDirectory: string, options: { includeAncestors?: boolean } = {}): boolean {
  const canonical = (value: string) => {
    const original = resolve(value);
    let candidate = original;
    const suffix: string[] = [];
    let links = 0;
    // Resolve the existing ancestor too: the reserved child may not exist yet.
    // A dangling alias can also name a future lock file, so follow its target
    // without opening any file descriptor. Loops remain unusable by the OS.
    for (;;) {
      try { return resolve(realpathSync(candidate), ...suffix); } catch { /* inspect missing/linked paths below */ }
      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          if (++links > 40) return original;
          candidate = resolve(dirname(candidate), readlinkSync(candidate));
          continue;
        }
      } catch { /* missing child; continue with its parent */ }
      const parent = dirname(candidate);
      if (parent === candidate) return original;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  };
  const contains = (root: string, candidate: string) => {
    const rel = relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const roots = ["file-mutation-locks", "models-config-backups"].flatMap(name => [join(resolve(agentDirectory), name), join(canonical(agentDirectory), name)]);
  return [resolve(target), canonical(target)].some(candidate => roots.some(root =>
    contains(root, candidate) || (options.includeAncestors === true && contains(candidate, root))));
}

/**
 * A SQLite RESERVED lock acts as an OS-backed mutex, not as a content store.
 * Unlike a timed lease it cannot expire while a process is paused, and the OS
 * releases it on a crash. Keep these files on a local filesystem and never
 * remove/replace them while any web instance uses the shared agent directory.
 */
export async function withFileMutationLock<T>(directory: string, target: string, action: () => Promise<T>): Promise<T> {
  let database: DatabaseSync | undefined;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)) {
      throw new FileMutationLockError("Invalid file-lock directory", 503);
    }
    const canonicalDirectory = await fs.realpath(directory);
    const key = createHash("sha256").update(target).digest("hex");
    const filename = join(canonicalDirectory, `${key}.sqlite`);
    const identity = await fs.lstat(filename).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (identity && (!identity.isFile() || identity.nlink !== 1)) throw new FileMutationLockError("Invalid file-lock file", 503);

    // Lazy-load a Node builtin: no native npm addon or external CLI is needed.
    // Do not open/close this file with fs: POSIX close can release another
    // SQLite connection's process-wide advisory locks for the same inode.
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(filename);
    const current = await fs.lstat(filename);
    if (!current.isFile() || (identity && (current.dev !== identity.dev || current.ino !== identity.ino)) || current.nlink !== 1) {
      throw new FileMutationLockError("File-lock file changed during access", 503);
    }
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  } catch (error) {
    database?.close();
    if (error instanceof FileMutationLockError) throw error;
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6) throw new FileMutationLockError("Another change is in progress; refresh and try again", 409);
    throw new FileMutationLockError("Unable to acquire the file lock; no changes were made", 503);
  }

  try { return await action(); }
  finally {
    // No content is written to this database. Closing also rolls back the
    // empty transaction, including when the file operation throws.
    database.close();
  }
}
