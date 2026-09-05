import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class FileOperationError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export function contentDigest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Resolve the trusted root once; refuse symlink components beneath it. */
export async function confinedFile(root: string, path: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const target = resolve(canonicalRoot, path);
  const rel = relative(canonicalRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FileOperationError("Path is outside the workspace", 403);
  }
  let current = canonicalRoot;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FileOperationError("Symbolic links are not supported for this operation", 403);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new FileOperationError("Invalid parent directory", 403);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && i === parts.length - 1) return target;
      throw error;
    }
  }
  return target;
}

export interface FileSnapshot {
  text: string;
  exists: boolean;
  version: string;
  mode: number;
}

/** Read through one non-following descriptor and reject concurrent writes. */
export async function readFileSnapshot(root: string, path: string, maxBytes: number): Promise<FileSnapshot> {
  const target = await confinedFile(root, path);
  let handle;
  try { handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", exists: false, version: "missing", mode: 0o600 };
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new FileOperationError("Symbolic link changed during access", 409);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new FileOperationError("Not a regular file", 400);
    if (before.size > maxBytes) throw new FileOperationError("File is too large", 413);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new FileOperationError("File is too large", 413);
    const after = await handle.stat();
    const stamp = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(":");
    if (stamp(before) !== stamp(after)) throw new FileOperationError("File changed; refresh and try again", 409);
    await confinedFile(root, path);
    const current = await fs.lstat(target);
    if (stamp(current) !== stamp(after)) throw new FileOperationError("File changed; refresh and try again", 409);
    const data = bytes.subarray(0, length);
    const text = data.toString("utf8");
    if (data.includes(0) || !Buffer.from(text).equals(data)) throw new FileOperationError("Binary files cannot be edited as text", 415);
    return { text, exists: true, version: contentDigest(Buffer.concat([Buffer.from(stamp(after)), data])), mode: after.mode & 0o777 };
  } finally { await handle.close(); }
}

declare global { var __piFileMutations: Set<string> | undefined; }

/** Serializes web mutations; editors outside this process do not share this lock. */
export async function withFileMutation<T>(root: string, path: string, action: () => Promise<T>): Promise<T> {
  const target = await confinedFile(root, path);
  const locks = globalThis.__piFileMutations ??= new Set();
  if (locks.has(target)) throw new FileOperationError("Another change is in progress; refresh and try again", 409);
  locks.add(target);
  try { return await action(); } finally { locks.delete(target); }
}

/** Caller holds withFileMutation. Recheck just before the atomic replacement. */
export async function replaceFileSnapshot(root: string, path: string, expected: FileSnapshot, text: string | null, maxBytes: number): Promise<void> {
  const target = await confinedFile(root, path);
  const temp = join(dirname(target), `.pi-save-${randomUUID()}.tmp`);
  let created = false;
  try {
    if (text !== null) {
      if (Buffer.byteLength(text) > maxBytes) throw new FileOperationError("File is too large", 413);
      const handle = await fs.open(temp, "wx", expected.mode);
      created = true;
      try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    }
    const current = await readFileSnapshot(root, path, maxBytes);
    if (current.version !== expected.version) throw new FileOperationError("File changed; refresh and try again", 409);
    if (text === null) { if (current.exists) await fs.unlink(target); }
    else await fs.rename(temp, target);
  } finally { if (created) await fs.unlink(temp).catch(() => {}); }
}
