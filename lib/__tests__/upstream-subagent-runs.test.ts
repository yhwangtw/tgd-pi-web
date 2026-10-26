import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunLimits } from "../agent-run-types";

const harness = vi.hoisted(() => ({
  hosts: [] as Array<{ sessionId: string; cwd: string; client: { request: ReturnType<typeof vi.fn> } }>,
  limits: undefined as AgentRunLimits | undefined,
  cancel: vi.fn(), retry: vi.fn(),
  manual: [{ id: "manual", name: "Manual", cwd: "/work", prompt: "Review", toolNames: [], status: "queued", trigger: "manual", createdAt: "2026-10-20T00:00:00Z" }],
}));
vi.mock("@/lib/upstream-subagents", () => ({ listUpstreamSubagentHosts: () => harness.hosts }));
vi.mock("@/lib/agent-run-supervisor", () => ({
  ensureAgentRunSupervisor: () => ({ maxConcurrency: 3, cancel: harness.cancel, retry: harness.retry }),
  AgentRunNotFoundError: class extends Error {},
  AgentRunConflictError: class extends Error {},
}));
vi.mock("@/lib/agent-run-store", () => ({ readAgentRunStore: () => ({ runs: harness.manual, subagentLimits: harness.limits }) }));

function status(state = "running", id = "async-1", extras: Record<string, unknown> = {}) {
  return {
    fleet: { entries: [{ key: "opaque-fleet-key", agent: "foreground" }], totalActive: 1 },
    asyncSnapshot: {
      kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1_792_700_000_000,
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      runs: [{ id, kind: "subagent", label: "Reviewer", state, startedAt: 1_792_699_000_000,
        children: [{ id: "workflow-key", kind: "step", state: "running" }] }],
      ...extras,
    },
  };
}
function host(sessionId = "parent-1", response: unknown = status()) {
  const value = { sessionId, cwd: "/work", client: { request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => response) } };
  harness.hosts.push(value);
  return value;
}
function mutation(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/agent-runs/id/action", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  harness.hosts = [];
  harness.limits = undefined;
  harness.cancel.mockReset(); harness.retry.mockReset();
});

describe("upstream background run projection", () => {
  it("uses native async roots with parent ownership and never exposes opaque fleet keys as runs", async () => {
    host(); host("parent-2");
    const adapter = await import("../upstream-subagent-runs");
    const value = await adapter.listUpstreamAgentRuns();
    expect(value.runs).toHaveLength(2);
    expect(value.runs[0]).toMatchObject({ engine: "upstream", parentSessionId: "parent-1", status: "running",
      upstream: { asyncId: "async-1", canStop: true, canRetry: false } });
    expect(value.runs[0].id).not.toBe(value.runs[1].id);
    expect(value.runs.every(run => run.sessionId === undefined)).toBe(true);
    expect(JSON.stringify(value.runs)).not.toContain("opaque-fleet-key");
    expect(JSON.stringify(value.runs)).not.toContain("workflow-key");
    expect(value.status.scope).toBe("active_and_cached_sessions");
  });

  it("retains the failed or unloaded parent's last snapshot while another parent updates", async () => {
    const one = host(); const two = host("parent-2");
    const adapter = await import("../upstream-subagent-runs");
    await adapter.listUpstreamAgentRuns();
    one.client.request.mockRejectedValue(new Error("private internal protocol failure"));
    two.client.request.mockResolvedValue(status("complete"));
    const partial = await adapter.listUpstreamAgentRuns();
    expect(partial.runs).toHaveLength(2);
    expect(partial.runs[0].upstream).toMatchObject({ statusStale: true, canStop: false });
    expect(partial.runs[1].status).toBe("completed");
    expect(partial.status).toMatchObject({ partial: true, unavailableHosts: 1 });
    expect(JSON.stringify(partial)).not.toContain("private internal");
    harness.hosts = [two];
    const unloaded = await adapter.listUpstreamAgentRuns();
    expect(unloaded.status).toMatchObject({ partial: true, inactiveHosts: 1 });
    expect(unloaded.runs).toHaveLength(2);
  });

  it("reports unavailable and truncated status even when there is no prior card", async () => {
    host().client.request.mockResolvedValue({ asyncSnapshot: { version: 2, runs: [] } });
    host("parent-2", status("paused", "async-2", { omitted: { runs: 4, children: 3 } }));
    const { listUpstreamAgentRuns } = await import("../upstream-subagent-runs");
    const value = await listUpstreamAgentRuns();
    expect(value.status).toMatchObject({ partial: true, unavailableHosts: 1, omittedRuns: 4, omittedChildren: 3 });
    expect(value.runs[0]).toMatchObject({ status: "interrupted", upstream: { state: "paused", canStop: true, canRetry: false } });
  });

  it("marks a byte-limited upstream snapshot partial even when its omission counts are zero", async () => {
    host("parent-1", status("running", "async-1", { omitted: { runs: 0, children: 0, byteLimitExceeded: true } }));
    const { listUpstreamAgentRuns } = await import("../upstream-subagent-runs");
    expect((await listUpstreamAgentRuns()).status.partial).toBe(true);
  });

  it("bounds concurrent status reads and does not wait forever for one unavailable host", async () => {
    vi.useFakeTimers();
    try {
      host().client.request.mockImplementation(() => new Promise(() => {}));
      const { listUpstreamAgentRuns } = await import("../upstream-subagent-runs");
      const one = listUpstreamAgentRuns(); const two = listUpstreamAgentRuns();
      await vi.advanceTimersByTimeAsync(3_001);
      expect((await one).status).toMatchObject({ partial: true, unavailableHosts: 1 });
      await two;
      expect(harness.hosts[0].client.request).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("upstream control ownership", () => {
  it("verifies the owning host and sends only the known native target; stop delivery is not completion", async () => {
    const one = host(); const two = host("parent-2");
    const adapter = await import("../upstream-subagent-runs");
    const run = await adapter.cancelUpstreamAgentRun(adapter.upstreamAgentRunId("parent-1", "async-1"));
    expect(one.client.request.mock.calls).toEqual([["status", {}], ["stop", { id: "async-1" }]]);
    expect(two.client.request).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: "running", upstream: { canStop: false, stopRequested: true } });
  });

  it("rejects filesystem targets, fleet keys and missing roots before any stop request", async () => {
    const one = host();
    const adapter = await import("../upstream-subagent-runs");
    await expect(adapter.cancelUpstreamAgentRun(adapter.upstreamAgentRunId("parent-1", "../outside"))).rejects.toMatchObject({ status: 400 });
    await expect(adapter.cancelUpstreamAgentRun(adapter.upstreamAgentRunId("parent-1", "opaque-fleet-key"))).rejects.toMatchObject({ status: 404 });
    await expect(adapter.cancelUpstreamAgentRun(adapter.upstreamAgentRunId("parent-1", "missing"))).rejects.toMatchObject({ status: 404 });
    expect(one.client.request.mock.calls.every(call => call[0] === "status")).toBe(true);
  });

  it("requires a fresh owning snapshot and never mutates from cached stale state", async () => {
    const one = host();
    const adapter = await import("../upstream-subagent-runs");
    const { runs } = await adapter.listUpstreamAgentRuns();
    one.client.request.mockRejectedValue(new Error("offline"));
    await expect(adapter.cancelUpstreamAgentRun(runs[0].id)).rejects.toMatchObject({ status: 503 });
    harness.hosts = [];
    await expect(adapter.cancelUpstreamAgentRun(runs[0].id)).rejects.toMatchObject({ status: 409 });
    expect(one.client.request.mock.calls.every(call => call[0] === "status")).toBe(true);
  });

  it("does not invent resumability or a follow-up message from a terminal status snapshot", async () => {
    const one = host("parent-1", status("complete"));
    const adapter = await import("../upstream-subagent-runs");
    const id = adapter.upstreamAgentRunId("parent-1", "async-1");
    await expect(adapter.retryUpstreamAgentRun(id)).rejects.toMatchObject({ status: 409 });
    await expect(adapter.cancelUpstreamAgentRun(id)).rejects.toMatchObject({ status: 409 });
    expect(one.client.request.mock.calls.every(call => call[0] === "status")).toBe(true);
  });
});

describe("agent run API integration", () => {
  it("reports saved positive limits as a delegation blocker and preserves them unchanged", async () => {
    const { GET } = await import("../../app/api/agent-runs/route");
    for (const limits of [{ maxTurns: 1 }, { maxCostUsd: 0.25 }, { timeoutMs: 60_000 }]) {
      harness.limits = limits;
      const body = await (await GET(new Request("http://localhost/api/agent-runs"))).json();
      expect(body.upstreamStatus.delegationBlockedBySavedLimits).toBe(true);
      expect(body.subagentLimits).toEqual(limits);
      expect(harness.limits).toEqual(limits);
    }
    for (const limits of [undefined, { maxTurns: 0, maxCostUsd: 0, timeoutMs: 0 }]) {
      harness.limits = limits;
      const body = await (await GET(new Request("http://localhost/api/agent-runs"))).json();
      expect(body.upstreamStatus.delegationBlockedBySavedLimits).toBe(false);
    }
  });

  it("lists upstream alongside SDK background runs and preserves filtering", async () => {
    host();
    const { GET } = await import("../../app/api/agent-runs/route");
    const response = await GET(new Request("http://localhost/api/agent-runs"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs.map((run: { id: string }) => run.id)).toEqual([expect.stringMatching(/^upstream_/), "manual"]);
    expect(body.counts).toMatchObject({ running: 1, completed: 0, queued: 1 });
    expect(body.upstreamStatus.scope).toBe("active_and_cached_sessions");
    const filtered = await GET(new Request("http://localhost/api/agent-runs?status=running&q=Reviewer&cwd=/work"));
    expect((await filtered.json()).runs).toHaveLength(1);
  });

  it("dispatches upstream stop without using caller paths or the legacy supervisor", async () => {
    const one = host();
    const { upstreamAgentRunId } = await import("../upstream-subagent-runs");
    const { POST } = await import("../../app/api/agent-runs/[id]/cancel/route");
    const response = await POST(mutation({ dir: "/private/other", id: "other" }), {
      params: Promise.resolve({ id: upstreamAgentRunId("parent-1", "async-1") }),
    });
    expect(response.status).toBe(202);
    expect(one.client.request).toHaveBeenLastCalledWith("stop", { id: "async-1" });
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it("returns a conflict for unsupported upstream retry and preserves SDK cancel/retry", async () => {
    host("parent-1", status("complete"));
    const { upstreamAgentRunId } = await import("../upstream-subagent-runs");
    const cancel = (await import("../../app/api/agent-runs/[id]/cancel/route")).POST;
    const retry = (await import("../../app/api/agent-runs/[id]/retry/route")).POST;
    const upstream = await retry(mutation(), { params: Promise.resolve({ id: upstreamAgentRunId("parent-1", "async-1") }) });
    expect(upstream.status).toBe(409);
    expect(harness.retry).not.toHaveBeenCalled();
    harness.cancel.mockResolvedValue(harness.manual[0]); harness.retry.mockReturnValue(harness.manual[0]);
    expect((await cancel(mutation(), { params: Promise.resolve({ id: "manual" }) })).status).toBe(200);
    expect((await retry(mutation(), { params: Promise.resolve({ id: "manual" }) })).status).toBe(202);
    expect(harness.cancel).toHaveBeenCalledWith("manual");
    expect(harness.retry).toHaveBeenCalledWith("manual");
  });
});
