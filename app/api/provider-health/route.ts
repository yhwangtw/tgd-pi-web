import { NextResponse } from "next/server";
import { buildProviderHealthReport } from "@/lib/provider-health";
import { createPiModelRuntime } from "@/lib/pi-model-runtime";

export const dynamic = "force-dynamic";

// Credential readiness only: this never returns secret values and does not
// send a paid model request. Pi resolves the same auth sources used by a run.
export async function GET() {
  try {
    const runtime = await createPiModelRuntime();
    const report = await buildProviderHealthReport(runtime);
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
