import { afterEach, describe, expect, it } from "vitest";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  loginClientKey,
  recordLoginFailure,
  resetLoginRateLimitsForTests,
} from "../login-rate-limit";

afterEach(resetLoginRateLimitsForTests);

describe("login rate limit", () => {
  it("blocks the fifth failure for fifteen minutes", () => {
    const now = 1_000_000;
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(recordLoginFailure("client", now + attempt).allowed).toBe(true);
    }
    const blocked = recordLoginFailure("client", now + 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(900);
    expect(checkLoginRateLimit("client", now + 10)).toMatchObject({ allowed: false });
    expect(checkLoginRateLimit("client", now + 15 * 60 * 1000 + 6).allowed).toBe(true);
  });

  it("clears failures after a successful login", () => {
    recordLoginFailure("client", 1_000);
    clearLoginFailures("client");
    expect(checkLoginRateLimit("client", 1_001).allowed).toBe(true);
  });

  it("prefers Cloudflare's client address", () => {
    expect(loginClientKey(new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.2, 10.0.0.1",
    }))).toBe("203.0.113.7");
  });
});
