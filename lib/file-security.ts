import path from "path";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { listAllSessions } from "@/lib/session-reader";
import { isFileMutationLockPath } from "./file-mutation-lock";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number; scope: string } | undefined;
  var __piAllowedRootsPending: { scope: string; promise: Promise<Set<string>> } | undefined;
  var __piSelectedWorkspaceRoots: Set<string> | undefined;
  var __piSelectedWorkspaceScope: string | undefined;
}

/** Explicit workspace selection precedes Pi's first persisted session. */
export function registerSelectedWorkspace(cwd: string): void {
  const scope = allowedRootsScope();
  if (globalThis.__piSelectedWorkspaceScope !== scope) {
    globalThis.__piSelectedWorkspaceRoots = new Set();
    globalThis.__piSelectedWorkspaceScope = scope;
  }
  (globalThis.__piSelectedWorkspaceRoots ??= new Set()).add(cwd);
  // Selections are merged on every request, including an in-flight index build.
}

const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function allowedRootsScope(): string {
  return JSON.stringify([getAgentDir(), homedir(), process.env.TGD_DIR ?? ""]);
}

async function loadAllowedRoots(home: string): Promise<Set<string>> {
  const sessions = await listAllSessions();
  const roots = new Set(sessions.flatMap(session => session.cwd ? [session.cwd] : []));
  const { resolveTgdDir } = await import("./tgd-artifacts");
  // Most sessions share a workspace. Resolve sibling artifacts once per cwd.
  for (const cwd of [...roots]) {
    const tgd = resolveTgdDir(cwd);
    if (tgd) roots.add(tgd);
  }
  try {
    for (const name of await readdir(home)) {
      if (/^pi-cwd-\d{8}$/.test(name)) roots.add(path.join(home, name));
    }
  } catch { /* Ignore an unreadable home directory. */ }
  return roots;
}

export async function getAllowedRoots(): Promise<Set<string>> {
  const now = Date.now();
  const scope = allowedRootsScope();
  const cached = globalThis.__piAllowedRootsCache;
  let roots: Set<string>;
  if (cached?.scope === scope && cached.expiresAt > now) roots = cached.roots;
  else {
    let pending = globalThis.__piAllowedRootsPending;
    if (pending?.scope !== scope) {
      pending = { scope, promise: loadAllowedRoots(homedir()) };
      globalThis.__piAllowedRootsPending = pending;
    }
    try {
      roots = await pending.promise;
      if (globalThis.__piAllowedRootsPending === pending && allowedRootsScope() === scope) {
        globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS, scope };
      }
    } finally {
      if (globalThis.__piAllowedRootsPending === pending) globalThis.__piAllowedRootsPending = undefined;
    }
  }
  // Callers cannot mutate cached permissions. Explicit selections stay fresh
  // without forcing another scan, and never cross agent-directory boundaries.
  return new Set([...roots, ...(globalThis.__piSelectedWorkspaceScope === scope ? globalThis.__piSelectedWorkspaceRoots ?? [] : [])]);
}

export function isPathAllowed(target: string, allowedRoots: Set<string>): boolean {
  if (isFileMutationLockPath(target, getAgentDir())) return false;
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

export {
  IGNORED_NAMES,
  IGNORED_SUFFIXES,
  TEXT_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  DOCX_PREVIEW_MAX_BYTES,
};
