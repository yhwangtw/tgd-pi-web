import { describe, expect, it } from "vitest";
import { buildProviderHealthReport, type ProviderHealthRuntime } from "../provider-health";

describe("buildProviderHealthReport", () => {
  it("separates ready, unconfigured, and broken providers without exposing credentials", async () => {
    const providers = [
      { id: "ready", name: "Ready AI" },
      { id: "missing", name: "Missing AI" },
      { id: "broken", name: "Broken AI" },
    ];
    const models = [
      { provider: "ready", id: "r1" },
      { provider: "missing", id: "m1" },
      { provider: "broken", id: "b1" },
    ];
    const runtime = {
      getProviders: () => providers,
      getModels: (providerId?: string) => models.filter((model) => !providerId || model.provider === providerId),
      getAvailableSnapshot: () => [models[0]],
      getError: () => undefined,
      getProviderAuthStatus: (providerId: string) => ({ configured: providerId !== "missing", source: "stored" }),
      checkAuth: async (providerId: string) => {
        if (providerId === "broken") throw new Error("credential expired");
        return providerId === "ready" ? { type: "oauth" as const, source: "OAuth" } : undefined;
      },
      listCredentials: async () => [{ providerId: "ready", type: "oauth" as const }],
    } as unknown as ProviderHealthRuntime;

    const report = await buildProviderHealthReport(runtime, { now: () => new Date("2026-08-08T00:00:00Z") });

    expect(report.summary).toMatchObject({ total: 3, ready: 1, needsAuth: 1, invalid: 1 });
    expect(report.providers.map((provider) => [provider.id, provider.status])).toEqual([
      ["broken", "invalid"],
      ["ready", "ready"],
      ["missing", "needs_auth"],
    ]);
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
