import { afterEach, describe, expect, it } from "vitest";
import { pushEnrollmentAllowed } from "../web-push";

const original = process.env.PIWEB_ACCESS_PASSWORD;
afterEach(() => { if (original === undefined) delete process.env.PIWEB_ACCESS_PASSWORD; else process.env.PIWEB_ACCESS_PASSWORD = original; });

describe("web push enrollment boundary", () => {
  it("allows loopback without an app password", () => {
    delete process.env.PIWEB_ACCESS_PASSWORD;
    expect(pushEnrollmentAllowed(new Request("http://127.0.0.1:30141/api/push"))).toBe(true);
    expect(pushEnrollmentAllowed(new Request("http://localhost:30141/api/push"))).toBe(true);
  });

  it("rejects remote enrollment unless the app access gate is enabled", () => {
    delete process.env.PIWEB_ACCESS_PASSWORD;
    expect(pushEnrollmentAllowed(new Request("https://pi.example.com/api/push"))).toBe(false);
    process.env.PIWEB_ACCESS_PASSWORD = "configured";
    expect(pushEnrollmentAllowed(new Request("https://pi.example.com/api/push"))).toBe(true);
  });
});
