import { describe, it, expect, afterEach } from "vitest";
import {
  cookieAuthorizes,
  derivePasswordVerifier,
  gateEnabled,
  isPublicGatePath,
  issueAccessToken,
  requestIsSameOrigin,
  timingSafeEqual,
} from "../access-gate";

const ORIGINAL = process.env.PIWEB_ACCESS_PASSWORD;
const ORIGINAL_SESSION_SECRET = process.env.PIWEB_SESSION_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PIWEB_ACCESS_PASSWORD;
  else process.env.PIWEB_ACCESS_PASSWORD = ORIGINAL;
  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.PIWEB_SESSION_SECRET;
  else process.env.PIWEB_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
});

describe("derivePasswordVerifier", () => {
  it("is deterministic and 64 hex chars (SHA-256)", async () => {
    const a = await derivePasswordVerifier("hunter2");
    const b = await derivePasswordVerifier("hunter2");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different passwords", async () => {
    expect(await derivePasswordVerifier("a")).not.toBe(await derivePasswordVerifier("b"));
  });
});

describe("timingSafeEqual", () => {
  it("true only for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("gate on/off via env", () => {
  it("gateEnabled reflects the env var", () => {
    delete process.env.PIWEB_ACCESS_PASSWORD;
    expect(gateEnabled()).toBe(false);
    process.env.PIWEB_ACCESS_PASSWORD = "secret";
    expect(gateEnabled()).toBe(true);
  });

  it("allows everything when the gate is off", async () => {
    delete process.env.PIWEB_ACCESS_PASSWORD;
    expect(await cookieAuthorizes(undefined)).toBe(true);
    expect(await cookieAuthorizes("anything")).toBe(true);
  });

  it("requires the correct token when the gate is on", async () => {
    process.env.PIWEB_ACCESS_PASSWORD = "secret";
    process.env.PIWEB_SESSION_SECRET = "independent-session-secret";
    const token = await issueAccessToken(1_000_000, "fixed-nonce");
    expect(await cookieAuthorizes(undefined)).toBe(false);
    expect(await cookieAuthorizes("wrong")).toBe(false);
    expect(await cookieAuthorizes(token, 1_000_000)).toBe(true);
    expect(await cookieAuthorizes(`${token.slice(0, -1)}x`, 1_000_000)).toBe(false);
    expect(await cookieAuthorizes(token, 1_000_000 + 31 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("does not put a password verifier in the session cookie", async () => {
    process.env.PIWEB_ACCESS_PASSWORD = "secret";
    process.env.PIWEB_SESSION_SECRET = "independent-session-secret";
    const token = await issueAccessToken(1_000_000, "fixed-nonce");
    expect(token).toMatch(/^v2\.\d+\.fixed-nonce\.[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain(await derivePasswordVerifier("secret"));
  });
});

describe("requestIsSameOrigin", () => {
  const request = (method: string, headers: Record<string, string> = {}, url = "https://pi.example.com/api/sessions") => ({
    method,
    headers: new Headers(headers),
    url,
  });

  it("allows safe methods and non-browser clients without Origin", () => {
    expect(requestIsSameOrigin(request("GET", { origin: "https://evil.example" }))).toBe(true);
    expect(requestIsSameOrigin(request("POST"))).toBe(true);
  });

  it("allows same-origin mutations through a forwarded deployment", () => {
    expect(requestIsSameOrigin(request("POST", {
      origin: "https://pi.example.com",
      host: "127.0.0.1:30141",
      "x-forwarded-host": "pi.example.com",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    }, "http://127.0.0.1:30141/api/sessions"))).toBe(true);
  });

  it("blocks cross-origin mutations", () => {
    expect(requestIsSameOrigin(request("POST", { origin: "https://evil.example" }))).toBe(false);
    expect(requestIsSameOrigin(request("POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(requestIsSameOrigin(request("POST", { origin: "not a url" }))).toBe(false);
  });
});

describe("isPublicGatePath (auth-gate scope)", () => {
  it("lets the login flow and static PWA/tab assets through", () => {
    for (const p of ["/login", "/api/auth/gate", "/icon.svg", "/favicon.ico", "/apple-icon.png", "/manifest.webmanifest", "/icons/icon-192.png"]) {
      expect(isPublicGatePath(p)).toBe(true);
    }
  });

  it("gates every API route, including file paths that end in an asset extension", () => {
    // Regression: an extension-based skip once let /api/files/<x>.png bypass
    // the gate and leak allowed-root images to unauthenticated callers.
    for (const p of [
      "/api/sessions",
      "/api/files/home/u/proj/README.md",
      "/api/files/home/u/proj/secret.png",
      "/api/files/home/u/proj/design.svg",
      "/api/files/home/u/proj/font.woff2",
      "/",
    ]) {
      expect(isPublicGatePath(p)).toBe(false);
    }
  });
});
