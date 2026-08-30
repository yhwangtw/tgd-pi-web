import { describe, expect, it } from "vitest";
import { inferToolSelectionMode, namesForToolSelection, TOOL_PRESET_DEFAULT, TOOL_PRESET_FULL, TOOL_PRESET_PLAN } from "../tool-selection";

describe("tool selection", () => {
  it("keeps inherit distinct from an explicit selection", () => {
    expect(namesForToolSelection("inherit")).toBeUndefined();
    expect(inferToolSelectionMode(undefined)).toBe("inherit");
    expect(inferToolSelectionMode([])).toBe("none");
  });

  it("recognizes the shared presets regardless of order", () => {
    expect(inferToolSelectionMode([...TOOL_PRESET_PLAN].reverse())).toBe("plan");
    expect(inferToolSelectionMode([...TOOL_PRESET_DEFAULT].reverse())).toBe("default");
    expect(inferToolSelectionMode([...TOOL_PRESET_FULL].reverse())).toBe("full");
    expect(namesForToolSelection("plan")).toEqual([...TOOL_PRESET_PLAN]);
    expect(TOOL_PRESET_PLAN).toContain("structured_output");
  });

  it("deduplicates custom tools", () => {
    expect(namesForToolSelection("custom", ["read", "mcp_demo_search", "read"]))
      .toEqual(["read", "mcp_demo_search"]);
  });
});
