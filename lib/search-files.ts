import { constants } from "fs";
import { lstat, open, opendir, realpath } from "fs/promises";
import path from "path";
import ignore, { type Ignore } from "ignore";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isFileMutationLockPath } from "./file-mutation-lock";
import { IGNORED_NAMES, isPathAllowed } from "./file-security";
import { normalizeFileSearchOptions, type FileSearchOptions } from "./file-search-options";

export interface SearchFile {
  name: string;
  relative: string;
  full: string;
  isDir: boolean;
}
export interface SearchWalkOptions extends Partial<FileSearchOptions> {
  signal?: AbortSignal;
  maxEntries?: number;
  maxDepth?: number;
  maxMs?: number;
}
interface IgnoreLayer { dir: string; rules: Ignore }
const WORKTREE_CONTAINERS = new Set([".worktrees", "worktrees"]);

/** Canonical containment: aliases of allowed roots work; escaping descendants do not. */
export async function resolveSearchRoot(cwd: string, allowed: Set<string>): Promise<string | null> {
  if (!path.isAbsolute(cwd) || !isPathAllowed(cwd, allowed)) return null;
  try {
    const canonical = await realpath(cwd);
    const roots = await Promise.all([...allowed].map((root) => realpath(root).catch(() => null)));
    return isPathAllowed(canonical, new Set(roots.filter((root): root is string => root !== null)))
      // Keep the authorized alias in result URLs for downstream file APIs.
      && (await lstat(canonical)).isDirectory() ? path.resolve(cwd) : null;
  } catch { return null; }
}

/** Bounded descriptor read; never follow a file symlink or open a device/FIFO. */
export async function readSearchFile(file: string, maxBytes = 1024 * 1024): Promise<Buffer | null> {
  if (isFileMutationLockPath(file, getAgentDir())) return null;
  if (!(await lstat(file)).isFile()) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > maxBytes ? null : buffer.subarray(0, length);
  } finally { await handle.close(); }
}

async function hasGit(dir: string): Promise<boolean> {
  try { await lstat(path.join(dir, ".git")); return true; } catch { return false; }
}

async function addIgnore(dir: string, layers: IgnoreLayer[]): Promise<IgnoreLayer[]> {
  try {
    const content = await readSearchFile(path.join(dir, ".gitignore"), 256 * 1024);
    return content ? [...layers, { dir, rules: ignore({ ignorecase: false }).add(content.toString("utf8")) }] : layers;
  } catch { return layers; }
}

async function ancestorIgnores(root: string): Promise<IgnoreLayer[]> {
  const ancestors: string[] = [];
  let dir = root;
  while (!(await hasGit(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) return []; // A non-repo workspace owns only its own rules.
    dir = parent;
    ancestors.push(dir);
  }
  let layers: IgnoreLayer[] = [];
  for (const ancestor of ancestors.reverse()) layers = await addIgnore(ancestor, layers);
  return layers;
}

function isIgnored(full: string, isDir: boolean, layers: IgnoreLayer[]): boolean {
  let ignored = false;
  for (const layer of layers) {
    const relative = path.relative(layer.dir, full).split(path.sep).join("/") + (isDir ? "/" : "");
    const match = layer.rules.test(relative);
    if (match.ignored) ignored = true;
    else if (match.unignored) ignored = false;
  }
  return ignored;
}

/** One bounded, symlink-free file universe for both search engines and @mentions.
 * Rules are project .gitignore files, not machine-global Git/rg configuration.
 * Dependencies/build output/.git stay excluded even with includeIgnored enabled.
 * Nested checkouts are opt-in and never expand outside the selected cwd.
 */
export async function walkSearchFiles(root: string, options: SearchWalkOptions = {}): Promise<{ entries: SearchFile[]; truncated: boolean }> {
  if (isFileMutationLockPath(root, getAgentDir())) return { entries: [], truncated: false };
  const opts = normalizeFileSearchOptions(options);
  options.signal?.throwIfAborted();
  const deadline = Date.now() + (options.maxMs ?? 5000);
  const maxEntries = options.maxEntries ?? 25_000;
  const maxDepth = options.maxDepth ?? 32;
  const queue = [{ dir: root, depth: 0, layers: opts.includeIgnored ? [] : await ancestorIgnores(root) }];
  const entries: SearchFile[] = [];
  let inspected = 0;
  let truncated = false;
  for (let head = 0; head < queue.length; head++) {
    options.signal?.throwIfAborted();
    if (head >= 4000 || inspected >= maxEntries || Date.now() >= deadline) { truncated = true; break; }
    const current = queue[head];
    const layers = opts.includeIgnored ? [] : await addIgnore(current.dir, current.layers);
    let dir;
    try { dir = await opendir(current.dir); } catch { truncated = true; continue; }
    for await (const entry of dir) {
      options.signal?.throwIfAborted();
      if (++inspected > maxEntries || Date.now() >= deadline) { truncated = true; break; }
      if (IGNORED_NAMES.has(entry.name) || (!entry.isDirectory() && !entry.isFile())) continue;
      const full = path.join(current.dir, entry.name);
      if (isFileMutationLockPath(full, getAgentDir())) continue;
      const isDir = entry.isDirectory();
      const container = isDir && WORKTREE_CONTAINERS.has(entry.name);
      const nested = isDir && await hasGit(full);
      if ((container || nested) && !opts.includeWorktrees) continue;
      // Opting in to nested checkouts also opens their conventional hidden/ignored
      // container; unrelated hidden/ignored files still require their own option.
      const checkoutBoundary = opts.includeWorktrees && (container || nested);
      if (!checkoutBoundary && !opts.includeHidden && entry.name.startsWith(".")) continue;
      if (!checkoutBoundary && !opts.includeIgnored && isIgnored(full, isDir, layers)) continue;
      entries.push({ name: entry.name, relative: path.relative(root, full), full, isDir });
      if (isDir) {
        if (current.depth >= maxDepth) truncated = true;
        else queue.push({ dir: full, depth: current.depth + 1, layers: checkoutBoundary ? [] : layers });
      }
    }
    if (inspected > maxEntries || Date.now() >= deadline) break;
  }
  // Stable shallow-first ordering regardless of filesystem iteration order.
  entries.sort((a, b) => a.relative.split(path.sep).length - b.relative.split(path.sep).length
    || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return { entries, truncated };
}

export async function searchFiles(root: string, query: string, options: SearchWalkOptions & { maxResults?: number } = {}) {
  const { entries, truncated } = await walkSearchFiles(root, options);
  const matches = entries.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()));
  const limit = options.maxResults ?? 200;
  return { results: matches.slice(0, limit), truncated: truncated || matches.length > limit };
}
