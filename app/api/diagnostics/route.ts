import { NextResponse } from "next/server";
import { collectDiagnosticsBundle } from "@/lib/diagnostics";
import { redactedErrorMessage } from "@/lib/redaction";
import { requestHasExplicitSameOrigin } from "@/lib/request-origin";

export const dynamic = "force-dynamic";

function assertExplicitSameOriginExport(req: Request): void {
  const consent = req.headers.get("x-pi-diagnostics-consent");
  if (!requestHasExplicitSameOrigin(req) || consent !== "export") {
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
