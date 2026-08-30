import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAgentRunStore,
  reconcileInterruptedAgentRuns,
  writeAgentRunStore,
} from "../agent-run-store";
import type { AgentRun, AgentRunStore } from "../agent-run-types";

const dirs: string[] = [];

function fixturePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-runs-test-"));
  dirs.push(dir);
  return join(dir, "agent-runs.json");
}

function run(status: AgentRun["status"], id = "run-1"): AgentRun {
  return {
    id,
    name: "Review auth",
    cwd: "/tmp/project",
    prompt: "Review the authentication changes",
    trigger: "manual",
    toolNames: ["read", "grep"],
    createdAt: "2026-07-26T01:00:00.000Z",
    status,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-run-store", () => {
  it("AC-1.1: round-trips daemon runs through an atomic private JSON file", () => {
    const path = fixturePath();
    const store: AgentRunStore = { version: 1, runs: [run("completed")] };

    writeAgentRunStore(store, path);

    expect(readAgentRunStore(path)).toEqual(store);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("AC-1.2: filters malformed records instead of exposing invalid run states", () => {
    const path = fixturePath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      maxConcurrency: 99,
      runs: [
        run("queued", "valid"),
        { ...run("queued", "bad-status"), status: "unknown" },
        { ...run("queued", "bad-tools"), toolNames: ["read", 42] },
      ],
    }));

    const store = readAgentRunStore(path);
    expect(store.runs.map((item) => item.id)).toEqual(["valid"]);
    expect(store.maxConcurrency).toBeUndefined();
  });

  it("AC-1.3: marks active runs interrupted after restart while preserving queued work", () => {
    const path = fixturePath();
    writeAgentRunStore({
      version: 1,
      runs: [
        { ...run("running", "running"), startedAt: "2026-07-26T01:01:00.000Z" },
        run("waiting_for_input", "waiting"),
        run("queued", "queued"),
      ],
    }, path);

    expect(reconcileInterruptedAgentRuns(path, new Date("2026-07-26T02:00:00.000Z"))).toBe(2);

    const runs = readAgentRunStore(path).runs;
    expect(runs.find((item) => item.id === "running")).toMatchObject({
      status: "interrupted",
      finishedAt: "2026-07-26T02:00:00.000Z",
      error: "The agent daemon restarted before this run completed",
    });
    expect(runs.find((item) => item.id === "waiting")?.status).toBe("interrupted");
    expect(runs.find((item) => item.id === "queued")?.status).toBe("queued");
  });

  it("AC-1.4: persists the user-selected concurrency limit across restarts", () => {
    const path = fixturePath();
    const store: AgentRunStore = {
      version: 1,
      runs: [run("queued")],
      maxConcurrency: 6,
    };

    writeAgentRunStore(store, path);

    expect(readAgentRunStore(path)).toMatchObject({
      version: 1,
      maxConcurrency: 6,
      runs: [{ id: "run-1" }],
    });
  });

  it("round-trips bounded subagent runs and rejects malformed limits", () => {
    const path = fixturePath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      runs: [
        { ...run("queued", "subagent"), trigger: "subagent", limits: { maxTurns: 24, maxCostUsd: 5, timeoutMs: 1_800_000 } },
        { ...run("queued", "bad-limit"), trigger: "subagent", limits: { maxTurns: 0 } },
      ],
    }));

    expect(readAgentRunStore(path).runs).toEqual([
      expect.objectContaining({
        id: "subagent",
        trigger: "subagent",
        limits: { maxTurns: 24, maxCostUsd: 5, timeoutMs: 1_800_000 },
      }),
    ]);
  });
});
