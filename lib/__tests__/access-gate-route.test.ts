import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/auth/gate/route";
import { resetLoginRateLimitsForTests } from "../login-rate-limit";

const ORIGINAL_PASSWORD = process.env.PIWEB_ACCESS_PASSWORD;
const ORIGINAL_SESSION_SECRET = process.env.PIWEB_SESSION_SECRET;

afterEach(() => {
  resetLoginRateLimitsForTests();
  if (ORIGINAL_PASSWORD === undefined) delete process.env.PIWEB_ACCESS_PASSWORD;
  else process.env.PIWEB_ACCESS_PASSWORD = ORIGINAL_PASSWORD;
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.PIWEB_SESSION_SECRET;
  else process.env.PIWEB_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
});

function loginRequest(password: string, ip = "203.0.113.10") {
  return new NextRequest("https://pi.example.com/api/auth/gate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ password }),
  });
}

describe("access gate route", () => {
  it("sets an expiring, secure HMAC session cookie after login", async () => {
    process.env.PIWEB_ACCESS_PASSWORD = "correct horse battery staple";
    process.env.PIWEB_SESSION_SECRET = "independent-session-secret-with-enough-entropy";

    const response = await POST(loginRequest("correct horse battery staple"));

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/piweb_gate=v2\.[^.]+\.[^.]+\.[A-Za-z0-9_-]+/u);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
  });

  it("rate-limits repeated failures but isolates client addresses", async () => {
    process.env.PIWEB_ACCESS_PASSWORD = "secret";
    process.env.PIWEB_SESSION_SECRET = "session-secret";

    for (let attempt = 1; attempt < 5; attempt++) {
      expect((await POST(loginRequest("wrong"))).status).toBe(401);
    }
    const blocked = await POST(loginRequest("wrong"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    expect((await POST(loginRequest("secret"))).status).toBe(429);
    expect((await POST(loginRequest("secret", "203.0.113.11"))).status).toBe(200);
  });
});
