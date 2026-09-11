import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { recordSecurityActivity, securityActivityPath } from "../security-activity";

it("isolates the real default audit writer before application modules import", () => {
  const dir = getAgentDir();
  expect(basename(dir)).toMatch(/^pi-web-unit-agent-/);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(dirname(securityActivityPath())).toBe(dir);
  recordSecurityActivity({ category: "security", action: "test", outcome: "success", summary: "Isolated fixture" });
  expect(readFileSync(securityActivityPath(), "utf8")).toContain("Isolated fixture");
});
