// ============================================================================
// App-level access gate.
//
// pi-web has no user accounts — it's a single-user (or trusted-small-team)
// self-hosted coding agent that can run bash and touch the filesystem. This
// adds ONE optional shared password so the app can be safely exposed beyond
// localhost (Tailscale, a tunnel, the LAN). It is a front-door lock, not an
// identity system.
//
// Opt-in: with no PIWEB_ACCESS_PASSWORD set, the gate is disabled and the app
// behaves exactly as before (local-only use stays frictionless).
//
// Runs in BOTH the Node runtime (login route) and the Edge runtime
// (Proxy), so all crypto here uses Web Crypto (globalThis.crypto.subtle),
// which exists in both.
// ============================================================================

export const AUTH_COOKIE = "piweb_gate";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

// Paths reachable without auth when the gate is on: the login flow plus the
// genuinely-static assets the browser fetches around login. Everything else —
// crucially every /api/* route — is gated.
//
// Deliberately NOT extension-based: /api/files/<path> serves files whose URL
// ends in the file's own extension (…/secret.png), so skipping by extension
// would leak allowed-root images/svgs/fonts to unauthenticated callers.
const PUBLIC_EXACT = new Set([
  "/login",
  "/api/auth/gate",
  "/icon.svg",
  "/favicon.ico",
  "/apple-icon.png",
  "/manifest.webmanifest",
]);
const PUBLIC_PREFIXES = ["/icons/"];

export function isPublicGatePath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Is the gate switched on? (i.e. a password is configured) */
export function gateEnabled(): boolean {
  return !!process.env.PIWEB_ACCESS_PASSWORD;
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic password verifier used only during login comparison. */
export async function derivePasswordVerifier(password: string): Promise<string> {
  const data = new TextEncoder().encode(`piweb-access-gate:v1:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function sessionSecret(): string | null {
  return process.env.PIWEB_SESSION_SECRET || process.env.PIWEB_ACCESS_PASSWORD || null;
}

async function signTokenPayload(payload: string): Promise<string | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

/** Issue an expiring, signed session token. The password hash is never stored in the cookie. */
export async function issueAccessToken(
  nowMs = Date.now(),
  nonce = base64Url(crypto.getRandomValues(new Uint8Array(18))),
): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + AUTH_COOKIE_MAX_AGE_SECONDS;
  const payload = `v2.${expires}.${nonce}`;
  const signature = await signTokenPayload(payload);
  if (!signature) throw new Error("Access gate session secret is unavailable");
  return `${payload}.${signature}`;
}

/** Constant-time string compare (avoids leaking length/prefix via timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Does this cookie value grant access under the current password? */
export async function cookieAuthorizes(cookieValue: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!gateEnabled()) return true; // gate off → everything is allowed
  if (!cookieValue) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(nowMs / 1000)) return false;
  const payload = parts.slice(0, 3).join(".");
  const expected = await signTokenPayload(payload);
  return expected !== null && timingSafeEqual(parts[3], expected);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Block explicit browser cross-origin mutations while allowing CLI clients with no Origin header. */
export function requestIsSameOrigin(request: Pick<Request, "headers" | "method" | "url">): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host") || requestUrl.host;
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwardedProto ? `${forwardedProto}:` : requestUrl.protocol;
    return originUrl.host === host && originUrl.protocol === protocol;
  } catch {
    return false;
  }
}
