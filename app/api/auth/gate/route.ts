import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  AUTH_COOKIE_MAX_AGE_SECONDS,
  derivePasswordVerifier,
  gateEnabled,
  issueAccessToken,
  timingSafeEqual,
} from "@/lib/access-gate";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  loginClientKey,
  recordLoginFailure,
} from "@/lib/login-rate-limit";

export const dynamic = "force-dynamic";

// GET /api/auth/gate — is the access gate switched on? (drives the logout UI)
export async function GET() {
  return NextResponse.json({ enabled: gateEnabled() });
}

// POST /api/auth/gate  body: { password }
// Verifies the shared access password and, on success, sets the gate cookie.
export async function POST(req: NextRequest) {
  if (!gateEnabled()) {
    // Nothing to log into — the gate is off.
    return NextResponse.json({ ok: true, gate: "disabled" });
  }

  const clientKey = loginClientKey(req.headers);
  const limit = checkLoginRateLimit(clientKey);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let password = "";
  try {
    ({ password = "" } = (await req.json()) as { password?: string });
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const submitted = await derivePasswordVerifier(password);
  const expected = await derivePasswordVerifier(process.env.PIWEB_ACCESS_PASSWORD as string);
  if (!timingSafeEqual(submitted, expected)) {
    const failure = recordLoginFailure(clientKey);
    return NextResponse.json(
      { error: failure.allowed ? "Incorrect password" : "Too many login attempts. Try again later." },
      {
        status: failure.allowed ? 401 : 429,
        headers: failure.allowed ? undefined : { "Retry-After": String(failure.retryAfterSeconds) },
      },
    );
  }

  clearLoginFailures(clientKey);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await issueAccessToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

// DELETE /api/auth/gate — log out (clear the cookie).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
