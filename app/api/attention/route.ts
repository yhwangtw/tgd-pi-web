import { collectAttentionItems } from "@/lib/attention-center";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const serverTime = new Date();
    const items = await collectAttentionItems(serverTime);
    return Response.json({ items, serverTime: serverTime.toISOString() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
