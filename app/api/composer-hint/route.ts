import { NextResponse } from "next/server";
import { requestIsSameOrigin } from "@/lib/access-gate";
import { isComposerHintRequest } from "@/lib/composer-hints";
import { generateComposerHint } from "@/lib/composer-hint-service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!req.headers.get("origin") || !requestIsSameOrigin(req)
    || (req.headers.has("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin")) {
    return NextResponse.json({ hint: null }, { status: 403, headers });
  }
  const reader = req.body?.getReader();
  if (!reader) return NextResponse.json({ hint: null }, { status: 400, headers });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 24_000) {
        await reader.cancel();
        return NextResponse.json({ hint: null }, { status: 413, headers });
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isComposerHintRequest(body)) return NextResponse.json({ hint: null }, { status: 400, headers });
    const hint = await generateComposerHint(body, req.signal);
    return NextResponse.json({ hint }, { headers });
  } catch { return NextResponse.json({ hint: null }, { status: 400, headers }); }
  finally { reader.releaseLock(); }
}
