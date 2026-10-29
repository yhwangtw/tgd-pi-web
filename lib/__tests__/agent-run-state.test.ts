import { describe, expect, it } from "vitest";
import { isRunProgressEvent, restoreRunClock } from "../agent-run-state";

describe("authoritative run clock", () => {
  const run = { id: "one", startedAt: 10_000, lastProgressAt: 20_000, observedAt: 130_000, phase: { kind: "thinking" } as const };
  it("restores elapsed and idle durations even when the browser clock differs", () => {
    expect(restoreRunClock(run, 1_000_000)).toEqual({ id: "one", startedAt: 880_000, lastProgressAt: 890_000 });
  });
  it("does not invent a clock for old servers or malformed metadata", () => {
    expect(restoreRunClock(null)).toBeNull();
    for (const invalid of [{ startedAt: NaN }, { lastProgressAt: 1 }, { observedAt: 2 }, { id: "" }]) {
      expect(restoreRunClock({ ...run, ...invalid })).toBeNull();
    }
  });
});


describe("meaningful run progress", () => {
  it.each(["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "bash_chunk", "auto_retry_start", "auto_compaction_end"])("counts %s", type => {
    expect(isRunProgressEvent(type)).toBe(true);
  });
  it.each(["connected", "session_snapshot", "run_timing", "extension_ui_request", "extension_ui_state", "heartbeat", "unknown"])("does not present %s as model work", type => {
    expect(isRunProgressEvent(type)).toBe(false);
  });
});
