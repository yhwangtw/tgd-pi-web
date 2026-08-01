import { OAuthWebBridge, submitOAuthWebInput, type OAuthWebEvent } from "@/lib/oauth-web-bridge";
import { invalidateRpcSessionsForAuthChange } from "@/lib/rpc-manager";
import { createPiModelRuntime } from "@/lib/pi-model-runtime";

export const dynamic = "force-dynamic";

// POST /api/auth/login/[provider] — frontend sends a redirect URL, code, or selection.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };
  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const result = submitOAuthWebInput(provider, token, code);
  if (result === "not_found") {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  if (result === "provider_mismatch") {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for OAuth flow.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: OAuthWebEvent | { type: "success" | "cancelled" } | { type: "error"; message: string }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let bridge: OAuthWebBridge | undefined;
      try {
        const runtime = await createPiModelRuntime();
        const providerInfo = runtime.getProvider(provider);
        if (!providerInfo?.auth.oauth) {
          send({ type: "error", message: `Unknown provider: ${provider}` });
          return;
        }

        bridge = new OAuthWebBridge(provider, send, abort.signal);
        await runtime.login(provider, "oauth", bridge.interaction);
        invalidateRpcSessionsForAuthChange();
        send({ type: "success" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Login cancelled" || abort.signal.aborted) send({ type: "cancelled" });
        else send({ type: "error", message });
      } finally {
        bridge?.cleanup();
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
