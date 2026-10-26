import { invalidateRpcSessionsForAuthChange } from "@/lib/rpc-manager";
import { createPiModelRegistry } from "@/lib/pi-model-runtime";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// GET /api/auth/api-key/[provider] — returns auth status (never returns the actual key)
export async function GET(_req: Request, { params }: Params) {
  const { provider } = await params;
  const { registry } = await createPiModelRegistry();
  const status = registry.getProviderAuthStatus(provider);
  const displayName = registry.getProviderDisplayName(provider);
  const models = registry.getAll().filter((m) => m.provider === provider).length;
  return NextResponse.json({ provider, displayName, configured: status.configured, source: status.source, models });
}

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const { apiKey } = await req.json() as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    const { runtime } = await createPiModelRegistry();
    let prompted = false;
    await runtime.login(provider, "api_key", {
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          const first = prompt.options[0];
          if (!first) throw new Error(`No authentication choices available for "${provider}"`);
          return first.id;
        }
        if (prompted) throw new Error(`Provider "${provider}" requires interactive configuration`);
        prompted = true;
        return apiKey.trim();
      },
      notify: () => {},
    });
    invalidateRpcSessionsForAuthChange();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const { runtime } = await createPiModelRegistry();
    await runtime.logout(provider);
    invalidateRpcSessionsForAuthChange();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
