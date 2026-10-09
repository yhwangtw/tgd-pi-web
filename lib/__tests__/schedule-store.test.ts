import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readScheduleStore, reconcileInterruptedRuns, writeScheduleStore } from "../schedule-store";
import type { AgentSchedule, ScheduleRun } from "../schedule-types";

const dirs: string[] = [];

function fixturePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedules-test-"));
  dirs.push(dir);
  return join(dir, "schedules.json");
}

function schedule(): AgentSchedule {
  return {
    id: "schedule-1",
    name: "Daily review",
    cwd: "/tmp/project",
    prompt: "Review changes",
    timing: { kind: "daily", time: "09:00" },
    timezone: "UTC",
    enabled: true,
    missedRunPolicy: "run_once",
    toolNames: ["read"],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    nextRunAt: "2026-07-24T09:00:00.000Z",
  };
}

function run(status: ScheduleRun["status"]): ScheduleRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    scheduleName: "Daily review",
    trigger: "scheduled",
    scheduledFor: "2026-07-23T09:00:00.000Z",
    startedAt: "2026-07-23T09:00:00.000Z",
    status,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("schedule-store", () => {
  it("preserves a durable run's immutable execution and question state across restart while failing legacy work", () => {
    const path = fixturePath();
    const original = schedule();
    const durable: ScheduleRun = { ...run("waiting_for_input"), id: "durable-run", engine: "durable", sessionId: "durable-session",
      execution: { cwd: original.cwd, prompt: original.prompt, toolNames: ["read", "ask_user"] } };
    writeScheduleStore({ version: 1, schedules: [{ ...original, engine: "durable", prompt: "Edited later" }], runs: [durable, run("running")] }, path);
    expect(reconcileInterruptedRuns(path)).toBe(1);
    const saved = readScheduleStore(path);
    expect(saved.runs[0]).toEqual(durable);
    expect(saved.schedules[0].engine).toBe("durable");
    expect(saved.runs[1].status).toBe("failed");
  });
  it("round-trips schedules through an atomic JSON file", () => {
    const path = fixturePath();
    writeScheduleStore({ version: 1, schedules: [schedule()], runs: [run("completed")] }, path);
    expect(readScheduleStore(path).schedules[0].name).toBe("Daily review");
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("treats malformed storage as an empty store", () => {
    const path = fixturePath();
    writeFileSync(path, "not-json");
    expect(readScheduleStore(path)).toEqual({ version: 1, schedules: [], runs: [] });
  });

  it("filters malformed records without exposing invalid UI states", () => {
    const path = fixturePath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      schedules: [{ ...schedule(), missedRunPolicy: "maybe" }],
      runs: [{ ...run("completed"), status: "unknown" }],
    }));
    expect(readScheduleStore(path)).toEqual({ version: 1, schedules: [], runs: [] });
  });

  it("marks active runs failed after a server restart", () => {
    const path = fixturePath();
    writeScheduleStore({ version: 1, schedules: [schedule()], runs: [run("waiting_for_input")] }, path);
    expect(reconcileInterruptedRuns(path, new Date("2026-07-23T12:00:00.000Z"))).toBe(1);
    const store = readScheduleStore(path);
    expect(store.runs[0]).toMatchObject({
      status: "failed",
      finishedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(store.schedules[0].lastRunStatus).toBe("failed");
  });
});
