import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSupportedNodeVersion, NODE_SUPPORT_RANGE } from "../node-support.mjs";

describe("shared Node support contract", () => {
  it.each(["22.19.0", "22.20.1", "23.4.0", "24.0.0", "v24.8.0", "26.0.0"])("supports stable %s", version => {
    expect(isSupportedNodeVersion(version)).toBe(true);
  });
  it.each(["20.19.0", "21.9.9", "22.18.99", "23.3.99", "24", "24.0", "24.0.0-nightly", "024.0.0", "24.0.0\n", "garbage", null, 24])("rejects unsupported or malformed %s", version => {
    expect(isSupportedNodeVersion(version)).toBe(false);
  });
  it("matches the published package engines contract", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.engines.node).toBe(NODE_SUPPORT_RANGE);
  });
});
