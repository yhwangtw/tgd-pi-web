import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_CAPABILITIES } from "../capabilities";

describe("product capability manifest", () => {
  it("keeps every shipped capability localized, boxed, and independent of a global Pi CLI", () => {
    const ids = PRODUCT_CAPABILITIES.capabilities.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const capability of PRODUCT_CAPABILITIES.capabilities) {
      expect(capability.title.en.trim()).not.toBe("");
      expect(capability.title.zh.trim()).not.toBe("");
      expect(capability.summary.en.trim()).not.toBe("");
      expect(capability.summary.zh.trim()).not.toBe("");
      expect(capability.packaging).toBe("built-in");
      expect(capability.globalPiCliRequired).toBe(false);
      expect(capability.evidence.length).toBeGreaterThan(0);
      for (const evidence of capability.evidence) {
        expect(existsSync(join(process.cwd(), evidence)), `${capability.id}: ${evidence}`).toBe(true);
      }
    }
  });

  it("records the special runtime boundaries that documentation must not hide", () => {
    const byId = new Map(PRODUCT_CAPABILITIES.capabilities.map((capability) => [capability.id, capability]));
    expect(byId.get("scheduled-agents")).toMatchObject({ backgroundServerRequired: true, trust: "operator" });
    expect(byId.get("mcp")).toMatchObject({ trust: "endpoint" });
    expect(byId.get("embedded-subagents")).toMatchObject({ foundation: "pi-sdk", webSupport: "adapted" });
    expect(byId.get("plan-mode")).toMatchObject({ foundation: "pi-extension-api", globalPiCliRequired: false });
    expect(byId.get("structured-output")).toMatchObject({ foundation: "pi-extension-api", trust: "none" });
    expect(byId.get("permission-gate")).toMatchObject({ foundation: "pi-extension-api", trust: "decision" });
    expect(byId.get("protected-paths")).toMatchObject({ foundation: "pi-extension-api", trust: "decision" });
    expect(byId.get("session-workspace")).toMatchObject({ trust: "host" });
  });
});
