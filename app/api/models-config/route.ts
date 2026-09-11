import { NextResponse } from "next/server";
import { requestIsSameOrigin } from "@/lib/access-gate";
import { MAX_MODELS_CONFIG_BYTES, ModelsConfigError, modelsConfigPath, readModelsConfig, saveModelsConfig, type ModelsConfigSnapshot } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

function headers(snapshot: ModelsConfigSnapshot): HeadersInit {
  return { ETag: `"${snapshot.revision}"`, "X-Models-Config-Path": encodeURIComponent(snapshot.path), "Cache-Control": "no-store" };
}
function failure(error: unknown) {
  return NextResponse.json({
    error: error instanceof ModelsConfigError ? error.message : "Models configuration could not be accessed safely",
    ...(error instanceof ModelsConfigError && error.code ? { code: error.code } : {}),
  }, {
    status: error instanceof ModelsConfigError ? error.status : 503, headers: { "Cache-Control": "no-store", "X-Models-Config-Path": encodeURIComponent(modelsConfigPath()) },
  });
}
export async function GET() {
  try {
    const snapshot = await readModelsConfig();
    return NextResponse.json(snapshot.config, { headers: headers(snapshot) });
  } catch (error) { return failure(error); }
}
async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new ModelsConfigError("A JSON models configuration is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MODELS_CONFIG_BYTES) { await reader.cancel(); throw new ModelsConfigError("Models configuration is too large", 413); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ModelsConfigError("A valid JSON models configuration is required"); }
  } finally { reader.releaseLock(); }
}
export async function PUT(req: Request) {
  try {
    const fetchSite = req.headers.get("sec-fetch-site");
    if (!req.headers.get("origin") || (fetchSite && fetchSite !== "same-origin") || !requestIsSameOrigin(req)) {
      throw new ModelsConfigError("Models changes require a same-origin browser request", 403);
    }
    const match = req.headers.get("if-match");
    if (!match) throw new ModelsConfigError("A models configuration revision is required; reload before saving", 428);
    if (!/^"(?:missing|[a-f0-9]{64})"$/.test(match)) throw new ModelsConfigError("Invalid models configuration revision; reload before saving", 400);
    const snapshot = await saveModelsConfig(await readBody(req), match.slice(1, -1));
    return NextResponse.json({ success: true, revision: snapshot.revision }, { headers: headers(snapshot) });
  } catch (error) { return failure(error); }
}
