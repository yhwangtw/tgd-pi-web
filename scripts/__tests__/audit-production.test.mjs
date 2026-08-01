import { describe, expect, it } from "vitest";
import { evaluateAudit } from "../audit-production.mjs";
import { isPatchedBraceExpansion } from "../patch-pi-brace-expansion.mjs";

const advisory = {
  source: 123,
  name: "brace-expansion",
  dependency: "brace-expansion",
  title: "DoS via unbounded expansion length",
  url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  severity: "high",
  range: "<=5.0.7",
};

function report(extra = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "high",
        via: [advisory],
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
      },
      ...extra,
    },
  };
}

describe("production audit policy", () => {
  it("recognizes the patched brace-expansion boundary", () => {
    expect(isPatchedBraceExpansion("5.0.7")).toBe(false);
    expect(isPatchedBraceExpansion("5.0.8")).toBe(true);
    expect(isPatchedBraceExpansion("5.0.9")).toBe(true);
  });

  it("blocks the former Pi brace-expansion exception", () => {
    expect(evaluateAudit(report())).toEqual({ blocking: ["brace-expansion"] });
  });

  it("blocks high-severity transitive parents", () => {
    const input = report({
      minimatch: {
        name: "minimatch",
        severity: "high",
        via: ["brace-expansion"],
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch"],
      },
    });
    expect(evaluateAudit(input)).toEqual({ blocking: ["brace-expansion", "minimatch"] });
  });

  it("blocks unrelated critical advisories too", () => {
    const input = report({
      next: {
        name: "next",
        severity: "critical",
        via: [{ title: "Unrelated", url: "https://github.com/advisories/GHSA-other", severity: "critical" }],
        nodes: ["node_modules/next"],
      },
    });
    expect(evaluateAudit(input)).toEqual({ blocking: ["brace-expansion", "next"] });
  });
});
