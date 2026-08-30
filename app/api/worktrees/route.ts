import { NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-security";
import { listWorktrees } from "@/lib/worktrees";
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from "@/lib/workspace-identity";

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
    return NextResponse.json({ worktrees: await listWorktrees(cwd) });
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

async function getWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  const cache = getIdentityCache();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;
  const worktrees = await listWorktrees(cwd).catch(() => []);
  const identity = resolveWorkspaceIdentity(cwd, worktrees);
  cache.set(cwd, { expiresAt: Date.now() + IDENTITY_TTL_MS, identity });
  return identity;
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
  const resolved = await mapWithConcurrency(cwds, IDENTITY_CONCURRENCY, async (cwd) => [cwd, await getWorkspaceIdentity(cwd)] as const);
  return NextResponse.json({ identities: Object.fromEntries(resolved) });
}
