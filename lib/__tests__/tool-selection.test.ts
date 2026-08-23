import { describe, expect, it } from "vitest";
import { inferToolSelectionMode, namesForToolSelection, TOOL_PRESET_DEFAULT, TOOL_PRESET_FULL } from "../tool-selection";

describe("tool selection", () => {
  it("keeps inherit distinct from an explicit selection", () => {
    expect(namesForToolSelection("inherit")).toBeUndefined();
    expect(inferToolSelectionMode(undefined)).toBe("inherit");
    expect(inferToolSelectionMode([])).toBe("none");
  });

  it("recognizes the shared presets regardless of order", () => {
    expect(inferToolSelectionMode([...TOOL_PRESET_DEFAULT].reverse())).toBe("default");
    expect(inferToolSelectionMode([...TOOL_PRESET_FULL].reverse())).toBe("full");
  });

  it("deduplicates custom tools", () => {
    expect(namesForToolSelection("custom", ["read", "mcp_demo_search", "read"]))
      .toEqual(["read", "mcp_demo_search"]);
  });
});
