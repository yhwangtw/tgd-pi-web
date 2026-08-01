import { invalidateRpcSessionsForAuthChange } from "@/lib/rpc-manager";
import { createPiModelRuntime } from "@/lib/pi-model-runtime";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const runtime = await createPiModelRuntime();
  const providerInfo = runtime.getProvider(provider);
  if (!providerInfo?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  await runtime.logout(provider);
  invalidateRpcSessionsForAuthChange();
  return Response.json({ ok: true });
}
