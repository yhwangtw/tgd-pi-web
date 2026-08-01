import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  cookieAuthorizes,
  gateEnabled,
  isPublicGatePath,
  requestIsSameOrigin,
} from "@/lib/access-gate";

// Reject explicit cross-origin mutations even when the optional password gate
// is disabled. This protects a localhost instance from drive-by browser POSTs
// while preserving non-browser clients that do not send an Origin header.
export async function proxy(req: NextRequest) {
  if (!requestIsSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }

  if (!gateEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublicGatePath(pathname)) return NextResponse.next();

  if (await cookieAuthorizes(req.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Static assets are allow-listed inside the proxy rather than skipped by
  // extension, so /api/files/*.png cannot bypass the access gate.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
