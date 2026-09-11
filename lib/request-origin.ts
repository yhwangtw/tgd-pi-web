import { requestIsSameOrigin } from "./access-gate";

/**
 * Sensitive browser actions require an explicit Origin, unlike general API
 * clients. Reuse the access gate's exact Host/forwarded-host + protocol check:
 * Next's internal Request.url is not necessarily the browser-facing origin.
 * Forwarded headers retain the access gate's existing trusted-proxy contract;
 * they never bypass the explicit Origin or Fetch Metadata requirements here.
 */
export function requestHasExplicitSameOrigin(request: Pick<Request, "headers" | "method" | "url">): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return Boolean(origin)
    && (!fetchSite || fetchSite === "same-origin")
    && requestIsSameOrigin(request);
}
