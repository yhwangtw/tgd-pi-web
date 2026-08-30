import { NextResponse } from "next/server";
import { collectDiagnosticsBundle } from "@/lib/diagnostics";
import { redactedErrorMessage } from "@/lib/redaction";

export const dynamic = "force-dynamic";

function assertExplicitSameOriginExport(req: Request): void {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  const consent = req.headers.get("x-pi-diagnostics-consent");
  if (!origin
    || (fetchSite && fetchSite !== "same-origin")
    || new URL(origin).host !== new URL(req.url).host
    || consent !== "export") {
    throw new Error("Diagnostics export requires an explicit same-origin browser action");
  }
}

export async function POST(req: Request) {
  try {
    assertExplicitSameOriginExport(req);
    return NextResponse.json(await collectDiagnosticsBundle(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: redactedErrorMessage(error) }, { status: 403 });
  }
}
