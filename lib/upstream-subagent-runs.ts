import type { AgentRun, AgentRunStatus, UpstreamAgentRunState, UpstreamAgentRunStatus } from "./agent-run-types";
import { listUpstreamSubagentHosts } from "./upstream-subagents";

type Host = ReturnType<typeof listUpstreamSubagentHosts>[number];
interface CachedHost {
  runs: AgentRun[];
  omittedRuns: number;
  omittedChildren: number;
  truncated: boolean;
  updatedAt: number;
}

// Also bound our retained snapshot when a previously opened parent is unloaded.
const MAX_HOSTS = 64;
const MAX_RUNS_PER_HOST = 100;
const REQUEST_TIMEOUT_MS = 3_000;
const ID_PREFIX = "upstream_";
const cache = new Map<string, CachedHost>();
let refresh: Promise<{ runs: AgentRun[]; status: UpstreamAgentRunStatus }> | undefined;
const STATUS: Record<UpstreamAgentRunState, AgentRunStatus> = {
  queued: "queued", running: "running", complete: "completed", failed: "failed",
  partial: "interrupted", paused: "interrupted", stopped: "cancelled", rejected: "failed",
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const time = (value: unknown): string | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : undefined;
// Identifiers, never directories or caller-selected artifact paths.
const validIdentity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const stoppable = (state: UpstreamAgentRunState): boolean => state === "running" || state === "queued" || state === "paused";

export class UpstreamAgentRunError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const isUpstreamAgentRunId = (id: string): boolean => id.startsWith(ID_PREFIX);
export function upstreamAgentRunId(parentSessionId: string, asyncId: string): string {
  return ID_PREFIX + Buffer.from(JSON.stringify([parentSessionId, asyncId])).toString("base64url");
}

function identity(id: string): { parentSessionId: string; asyncId: string } {
  try {
    if (!isUpstreamAgentRunId(id) || id.length > 512) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(id.slice(ID_PREFIX.length), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every(validIdentity)
      || upstreamAgentRunId(parsed[0], parsed[1]) !== id) throw new Error();
    return { parentSessionId: parsed[0], asyncId: parsed[1] };
  } catch {
    throw new UpstreamAgentRunError("Invalid background run identifier", 400);
  }
}

async function request(host: Host, method: "status" | "stop", params: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      host.client.request(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Background status timed out")), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function project(host: Host, response: unknown): CachedHost {
  const snapshot = record(response) && record(response.asyncSnapshot) ? response.asyncSnapshot : undefined;
  if (!snapshot || snapshot.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) {
    throw new Error("Background status is unavailable");
  }
  const previous = new Map(cache.get(host.sessionId)?.runs.map(run => [run.id, run]));
  const runs: AgentRun[] = [];
  let rejected = 0;
  for (const node of snapshot.runs.slice(0, MAX_RUNS_PER_HOST)) {
    if (!record(node) || (node.kind !== "subagent" && node.kind !== "workflow") || !validIdentity(node.id)
      || typeof node.state !== "string" || !Object.hasOwn(STATUS, node.state)) {
      rejected++;
      continue;
    }
    const state = node.state as UpstreamAgentRunState;
    const id = upstreamAgentRunId(host.sessionId, node.id);
    if (runs.some(run => run.id === id)) { rejected++; continue; }
    const old = previous.get(id);
    const stopRequested = old?.upstream?.stopRequested === true && stoppable(state);
    const createdAt = time(node.startedAt) ?? old?.createdAt ?? time(snapshot.generatedAt) ?? new Date().toISOString();
    const finishedAt = time(node.endedAt);
    runs.push({
      id, engine: "upstream", trigger: "subagent", name: typeof node.label === "string"
        ? node.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "Subagent" : "Subagent",
      cwd: host.cwd, prompt: "", toolNames: [], status: STATUS[state], createdAt,
      ...(time(node.startedAt) ? { startedAt: time(node.startedAt) } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      parentSessionId: host.sessionId,
      upstream: { asyncId: node.id, state, canStop: stoppable(state) && !stopRequested, canRetry: false,
        ...(stopRequested ? { stopRequested: true } : {}) },
    });
  }
  const omitted = record(snapshot.omitted) ? snapshot.omitted : {};
  return {
    runs, omittedRuns: count(omitted.runs) + Math.max(0, snapshot.runs.length - MAX_RUNS_PER_HOST) + rejected,
    omittedChildren: count(omitted.children), truncated: omitted.byteLimitExceeded === true, updatedAt: Date.now(),
  };
}

function prune(): number {
  if (cache.size <= MAX_HOSTS) return 0;
  const oldest = [...cache].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const removed = cache.size - MAX_HOSTS;
  for (const [id] of oldest.slice(0, removed)) cache.delete(id);
  return removed;
}

/** Read upstream-owned facts only; never start jobs or scan arbitrary directories. */
export async function listUpstreamAgentRuns(): Promise<{ runs: AgentRun[]; status: UpstreamAgentRunStatus }> {
  if (refresh) return refresh;
  refresh = (async () => {
    const hosts = listUpstreamSubagentHosts().filter(host => validIdentity(host.sessionId));
    const selected = hosts.slice(0, MAX_HOSTS);
    const available = new Set<string>();
    let unavailableHosts = 0;
    const results = await Promise.allSettled(selected.map(async host => {
      const value = project(host, await request(host, "status", {}));
      cache.set(host.sessionId, value);
      available.add(host.sessionId);
    }));
    for (const result of results) if (result.status === "rejected") unavailableHosts++;
    const evictedHosts = prune();
    const live = new Set(selected.map(host => host.sessionId));
    let inactiveHosts = 0;
    let omittedRuns = 0;
    let omittedChildren = 0;
    let truncated = false;
    const runs: AgentRun[] = [];
    for (const [sessionId, value] of cache) {
      const stale = !available.has(sessionId);
      if (!live.has(sessionId)) inactiveHosts++;
      omittedRuns += value.omittedRuns;
      omittedChildren += value.omittedChildren;
      truncated ||= value.truncated;
      runs.push(...value.runs.map(run => stale ? {
        ...run, upstream: { ...run.upstream!, statusStale: true, canStop: false, canRetry: false },
      } : structuredClone(run)));
    }
    return { runs, status: {
      scope: "active_and_cached_sessions", activeHosts: selected.length,
      unavailableHosts, inactiveHosts, omittedHosts: Math.max(0, hosts.length - selected.length) + evictedHosts,
      omittedRuns, omittedChildren,
      partial: unavailableHosts > 0 || inactiveHosts > 0 || hosts.length > selected.length || evictedHosts > 0 || omittedRuns > 0 || omittedChildren > 0 || truncated,
    } };
  })();
  try { return await refresh; } finally { refresh = undefined; }
}

async function verifiedRun(id: string): Promise<{ host: Host; run: AgentRun }> {
  const target = identity(id);
  const host = listUpstreamSubagentHosts().find(host => host.sessionId === target.parentSessionId);
  if (!host) throw new UpstreamAgentRunError("Open the parent chat before controlling this background run", 409);
  let value: CachedHost;
  try { value = project(host, await request(host, "status", {})); }
  catch { throw new UpstreamAgentRunError("Could not refresh this background run. Try again.", 503); }
  cache.set(host.sessionId, value);
  prune();
  const run = value.runs.find(run => run.upstream?.asyncId === target.asyncId);
  if (!run) throw new UpstreamAgentRunError("Run not found in its parent chat", 404);
  return { host, run };
}

export async function cancelUpstreamAgentRun(id: string): Promise<AgentRun> {
  const { host, run } = await verifiedRun(id);
  if (!run.upstream?.canStop) throw new UpstreamAgentRunError("This background run cannot be stopped in its current state", 409);
  try { await request(host, "stop", { id: run.upstream.asyncId }); }
  catch { throw new UpstreamAgentRunError("Could not confirm the stop request. Refresh the run before trying again.", 503); }
  // Acknowledged delivery is not terminal proof. Keep the last known state.
  const requested: AgentRun = { ...run, upstream: { ...run.upstream, canStop: false, stopRequested: true } };
  const saved = cache.get(host.sessionId);
  if (saved) saved.runs = saved.runs.map(item => item.id === id ? requested : item);
  return requested;
}

export async function retryUpstreamAgentRun(id: string): Promise<never> {
  await verifiedRun(id);
  // v1 asyncSnapshot carries no recovery contract or follow-up message. The
  // upstream resume RPC requires both a resolvable target and an explicit message.
  throw new UpstreamAgentRunError("Continue this work from its parent chat; recovery details are not available here", 409);
}
