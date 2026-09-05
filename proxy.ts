import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  cookieAuthorizes,
  gateEnabled,
  isPublicGatePath,
  requestIsSameOrigin,
} from "@/lib/access-gate";

// API reads and mutations reject explicit cross-origin browser requests even
// without the optional password gate. CLI clients still require authentication
// when the gate is enabled; Fetch Metadata is not an authentication mechanism.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const originSensitive = (response: NextResponse) => {
    if (isApi) {
      response.headers.append("Vary", "Origin, Sec-Fetch-Site");
      response.headers.set("Cache-Control", "private, no-store");
    }
    return response;
  };
  if (!requestIsSameOrigin(req)) {
    return originSensitive(NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 }));
  }

  if (!gateEnabled()) return originSensitive(NextResponse.next());

  if (isPublicGatePath(pathname)) return originSensitive(NextResponse.next());

  if (await cookieAuthorizes(req.cookies.get(AUTH_COOKIE)?.value)) {
    return originSensitive(NextResponse.next());
  }

  if (isApi) {
    return originSensitive(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
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
