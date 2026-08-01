import { describe, expect, it } from "vitest";
import { evaluateAudit } from "../audit-production.mjs";

const allowedAdvisory = {
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
        via: [allowedAdvisory],
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
      },
      ...extra,
    },
  };
}

describe("production audit policy", () => {
  it("allows only the exact upstream Pi advisory and installed version", () => {
    expect(evaluateAudit(report(), "5.0.7")).toEqual({ ignored: ["brace-expansion"], blocking: [] });
    expect(evaluateAudit(report(), "5.0.8").blocking).toEqual(["brace-expansion"]);
  });

  it("allows a transitive parent only when every blocking cause is allowlisted", () => {
    const input = report({
      minimatch: {
        name: "minimatch",
        severity: "high",
        via: ["brace-expansion"],
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch"],
      },
    });
    expect(evaluateAudit(input, "5.0.7")).toEqual({
      ignored: ["brace-expansion", "minimatch"],
      blocking: [],
    });
  });

  it("blocks any unrelated or changed advisory", () => {
    const input = report({
      next: {
        name: "next",
        severity: "critical",
        via: [{ title: "Unrelated", url: "https://github.com/advisories/GHSA-other", severity: "critical" }],
        nodes: ["node_modules/next"],
      },
    });
    expect(evaluateAudit(input, "5.0.7")).toEqual({
      ignored: ["brace-expansion"],
      blocking: ["next"],
    });
  });
});
