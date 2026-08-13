import { describe, it, expect } from "vitest";
import { phaseLabel } from "../RunStatus";

describe("phaseLabel", () => {
  it("null phase falls back to thinking", () => {
    expect(phaseLabel(null)).toBe("Thinking...");
  });

  it("waiting_model", () => {
    expect(phaseLabel({ kind: "waiting_model" })).toBe("Waiting for model...");
  });

  it("running_tools with no tools yet", () => {
    expect(phaseLabel({ kind: "running_tools", tools: [] })).toBe("Running tool...");
  });

  it("running_tools with one tool", () => {
    expect(phaseLabel({ kind: "running_tools", tools: [{ id: "1", name: "bash" }] })).toBe("Running bash...");
  });

  it("running_tools lists up to three tools", () => {
    const tools = [
      { id: "1", name: "bash" },
      { id: "2", name: "read" },
      { id: "3", name: "edit" },
    ];
    expect(phaseLabel({ kind: "running_tools", tools })).toBe("Running bash, read, edit...");
  });

  it("running_tools truncates beyond three tools", () => {
    const tools = [
      { id: "1", name: "bash" },
      { id: "2", name: "read" },
      { id: "3", name: "edit" },
      { id: "4", name: "grep" },
    ];
    expect(phaseLabel({ kind: "running_tools", tools })).toBe("Running bash, read (+2)...");
  });
});
