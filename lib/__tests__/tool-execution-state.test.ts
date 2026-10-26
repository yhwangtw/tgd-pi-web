import { describe, it, expect } from "vitest";
import { toolExecutionState, toolGroupState } from "../tool-execution-state";

describe("tool result evidence", () => {
  it("requires results for success and lets late results supersede cancellation", () => {
    expect(toolExecutionState("a")).toBe("unknown");
    expect(toolExecutionState("a", undefined, { running: true })).toBe("pending");
    expect(toolExecutionState("a", undefined, { running: true, preparingId: "a" })).toBe("preparing");
    expect(toolExecutionState("a", undefined, { running: true, activeIds: new Set(["a", "b"]) })).toBe("running");
    expect(toolExecutionState("a", undefined, { running: false, cancelled: true })).toBe("cancelled");
    expect(toolExecutionState("a", { role: "toolResult", toolCallId: "a", content: [] }, { running: false, cancelled: true })).toBe("success");
    expect(toolExecutionState("a", { role: "toolResult", toolCallId: "a", content: [], isError: true })).toBe("error");
  });
  it("does not call partially finished parallel work successful", () => {
    expect(toolGroupState(["success", "running"])).toBe("running");
    expect(toolGroupState(["error", "pending"])).toBe("pending");
    expect(toolGroupState(["success", "unknown"])).toBe("unknown");
    expect(toolGroupState(["success", "cancelled"])).toBe("cancelled");
    expect(toolGroupState(["success", "success"])).toBe("success");
    expect(toolGroupState([])).toBe("unknown");
  });
});
