import { createPiModelRuntime } from "@/lib/pi-model-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = await createPiModelRuntime();
  const providers = runtime.getProviders().filter((provider) => provider.auth.oauth);

  const EXCLUDED = new Set(["anthropic"]);
  const DISPLAY_NAMES: Record<string, string> = {
    "openai-codex": "ChatGPT Plus/Pro",
    "github-copilot": "GitHub Copilot",
  };

  const result = await Promise.all(
    providers
      .filter((p) => !EXCLUDED.has(p.id))
      .map(async (p) => {
        const loggedIn = runtime.getProviderAuthStatus(p.id).configured;
        return {
          id: p.id,
          name: DISPLAY_NAMES[p.id] ?? p.name,
          usesCallbackServer: false,
          loggedIn,
        };
      })
  );

  return Response.json({ providers: result });
}
