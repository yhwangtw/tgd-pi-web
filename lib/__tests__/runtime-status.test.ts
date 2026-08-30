import { describe, expect, it } from "vitest";
import { deploymentSafetyFromEnv } from "../runtime-status";

describe("deploymentSafetyFromEnv", () => {
  it("reports a production instance with separate secrets as remote-ready", () => {
    const status = deploymentSafetyFromEnv({
      NODE_ENV: "production",
      PIWEB_ACCESS_PASSWORD: "access-password",
      PIWEB_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    });
    expect(status).toMatchObject({
      boundary: "single-user",
      webCliIndependent: true,
      safetyGuard: true,
      scopedAuthorizationTtlSeconds: 300,
      toolIsolation: "host-process",
      accessGate: true,
      independentSessionSecret: true,
      remoteReady: true,
    });
    expect(status.warnings).toHaveLength(2);
    expect(status.warnings.join(" ")).toMatch(/not an OS sandbox/);
  });

  it("does not treat a development server or shared/short secret as remote-ready", () => {
    const status = deploymentSafetyFromEnv({
      NODE_ENV: "development",
      PIWEB_ACCESS_PASSWORD: "same-secret",
      PIWEB_SESSION_SECRET: "same-secret",
    });
    expect(status.remoteReady).toBe(false);
    expect(status.independentSessionSecret).toBe(false);
    expect(status.warnings.join(" ")).toMatch(/Development mode/);
    expect(status.warnings.join(" ")).toMatch(/PIWEB_SESSION_SECRET/);
  });
});
