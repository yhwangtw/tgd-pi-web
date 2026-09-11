import { NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-security";
import { readWorktreeState, type Worktree } from "@/lib/worktrees";
import { pendingWorkspaceIdentity, resolveWorkspaceIdentity, type WorkspaceIdentity } from "@/lib/workspace-identity";

export const dynamic = "force-dynamic";

// GET /api/worktrees?cwd=<abs>
// Lists the git worktrees of the repo at cwd (main checkout first; prunable /
// missing checkouts filtered). Empty list for non-git dirs.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  const roots = await getAllowedRoots();
  if (!isPathAllowed(cwd, roots)) {
    return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
  }

  try {
    const { worktrees, identity } = await getWorkspaceData(cwd, true);
    return NextResponse.json({ worktrees, identity });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

const MAX_IDENTITY_CWDS = 128;
const IDENTITY_CONCURRENCY = 6;
const IDENTITY_TTL_MS = 20_000;

interface IdentityCacheEntry {
  expiresAt: number;
  identity: WorkspaceIdentity;
  worktrees: Worktree[];
}

declare global {
  var __piWorkspaceIdentityCache: Map<string, IdentityCacheEntry> | undefined;
}

function getIdentityCache(): Map<string, IdentityCacheEntry> {
  if (!globalThis.__piWorkspaceIdentityCache) globalThis.__piWorkspaceIdentityCache = new Map();
  return globalThis.__piWorkspaceIdentityCache;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getWorkspaceData(cwd: string, fresh = false): Promise<IdentityCacheEntry> {
  const cache = getIdentityCache();
  const cached = cache.get(cwd);
  if (!fresh && cached && cached.expiresAt > Date.now() && cached.worktrees) return cached;
  const result = await readWorktreeState(cwd);
  const resolved = resolveWorkspaceIdentity(result.canonicalCwd, result.worktrees);
  const identity = result.state === "unknown" || (result.state === "ready" && !resolved.isGit)
    ? pendingWorkspaceIdentity(cwd, "unknown")
    : { ...resolved, sourceCwd: cwd };
  const entry = { expiresAt: Date.now() + (identity.state === "unknown" ? 2_000 : IDENTITY_TTL_MS), identity, worktrees: result.worktrees };
  cache.set(cwd, entry);
  return entry;
}

// POST /api/worktrees { cwds: string[] }
// Batch-resolves repository/branch labels for conversation rows without an
// N+1 request per session. Only session-allowed paths are accepted.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const input = body && typeof body === "object" && Array.isArray((body as { cwds?: unknown }).cwds)
    ? (body as { cwds: unknown[] }).cwds
    : null;
  if (!input) return NextResponse.json({ error: "cwds required" }, { status: 400 });
  const cwds = [...new Set(input.filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (cwds.length > MAX_IDENTITY_CWDS) {
    return NextResponse.json({ error: `maximum ${MAX_IDENTITY_CWDS} cwds` }, { status: 413 });
  }

  const roots = await getAllowedRoots();
  if (cwds.some((cwd) => !isPathAllowed(cwd, roots))) {
    return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
  }
  const resolved = await mapWithConcurrency(cwds, IDENTITY_CONCURRENCY, async (cwd) => [cwd, (await getWorkspaceData(cwd)).identity] as const);
  return NextResponse.json({ identities: Object.fromEntries(resolved) });
}
