import { describe, expect, it } from "vitest";
import { localToolClock, subagentProgress } from "../tool-activity";

describe("observed tool activity", () => {
  it("maps the same tool start across devices without making up missing times", () => {
    expect(localToolClock({ id: "a", name: "bash", startedAt: 20_000 }, 30_000, 1_000_000).startedAt).toBe(990_000);
    expect(localToolClock({ id: "a", name: "bash" }, 30_000).startedAt).toBeUndefined();
    expect(localToolClock({ id: "a", name: "bash", startedAt: 40_000 }, 30_000).startedAt).toBeUndefined();
  });
  it("projects stable upstream child identities and only explicitly reported states", () => {
    const progress = [
      { index: 7, agent: "reviewer", status: "running", currentTool: "read", currentPath: "a.ts" },
      { index: 2, agent: "reviewer", status: "completed" },
      { index: 9, agent: "scout", status: "future-state" },
      { index: 2, agent: "duplicate", status: "running" },
    ];
    expect(subagentProgress({ details: { progress } })).toEqual([
      { id: "7", label: "reviewer", state: "running", target: "read · a.ts" },
      { id: "2", label: "reviewer", state: "completed" },
    ]);
    expect(subagentProgress({ details: { results: [{ agent: "not-proof", exitCode: 0 }] } })).toBeUndefined();
    expect(subagentProgress({ details: { progress: [] } })).toEqual([]);
  });
});
