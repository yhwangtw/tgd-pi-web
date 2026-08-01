import { describe, expect, it, vi } from "vitest";
import { buildModelCatalog, resolveModelCatalogCwd, resolveModelCatalogSource } from "../model-catalog";

const extensionModel = {
  id: "team-fast",
  name: "Team Fast",
  provider: "team-ai",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

describe("model catalog", () => {
  it("serializes extension-registered models from the supplied registry", () => {
    const registry = { getAvailable: () => [extensionModel] };
    const settings = {
      getDefaultProvider: () => "team-ai",
      getDefaultModel: () => "team-fast",
    };

    const catalog = buildModelCatalog(registry, settings);

    expect(catalog.modelList).toContainEqual({ id: "team-fast", name: "Team Fast", provider: "team-ai" });
    expect(catalog.models["team-ai:team-fast"]).toBe("Team Fast");
    expect(catalog.defaultModel).toEqual({ provider: "team-ai", modelId: "team-fast" });
  });

  it("uses the active session registry as the source of truth", async () => {
    const sessionSource = {
      registry: { getAvailable: () => [extensionModel] },
      settings: { getDefaultProvider: () => "team-ai", getDefaultModel: () => "team-fast" },
      diagnostics: [],
    };
    const createCwdSource = vi.fn();

    const source = await resolveModelCatalogSource({
      sessionId: "session-1",
      cwd: "/workspace",
      getSessionSource: () => sessionSource,
      createCwdSource,
    });

    expect(source).toBe(sessionSource);
    expect(createCwdSource).not.toHaveBeenCalled();
  });

  it("waits for an active session source to refresh before returning it", async () => {
    const sessionSource = {
      registry: { getAvailable: () => [extensionModel] },
      settings: { getDefaultProvider: () => "team-ai", getDefaultModel: () => "team-fast" },
      diagnostics: [],
    };
    let resolveSource: ((source: typeof sessionSource) => void) | undefined;
    const getSessionSource = vi.fn(() => new Promise<typeof sessionSource>((resolve) => {
      resolveSource = resolve;
    }));
    const createCwdSource = vi.fn();

    const pending = resolveModelCatalogSource({
      sessionId: "session-1",
      cwd: "/workspace",
      getSessionSource,
      createCwdSource,
    });

    expect(getSessionSource).toHaveBeenCalledWith("session-1");
    expect(createCwdSource).not.toHaveBeenCalled();
    resolveSource?.(sessionSource);
    await expect(pending).resolves.toBe(sessionSource);
  });

  it("loads cwd-bound services when there is no active session", async () => {
    const cwdSource = {
      registry: { getAvailable: () => [extensionModel] },
      settings: { getDefaultProvider: () => "team-ai", getDefaultModel: () => "team-fast" },
      diagnostics: [],
    };
    const createCwdSource = vi.fn().mockResolvedValue(cwdSource);

    const source = await resolveModelCatalogSource({
      sessionId: null,
      cwd: "/workspace",
      getSessionSource: () => null,
      createCwdSource,
    });

    expect(source).toBe(cwdSource);
    expect(createCwdSource).toHaveBeenCalledWith("/workspace");
  });

  it("never trusts a cwd supplied to the read-only GET endpoint", () => {
    expect(resolveModelCatalogCwd({
      method: "GET",
      requestedCwd: "/tmp/untrusted",
      sessionCwd: null,
    })).toBeNull();
  });

  it("uses session-owned cwd for GET and explicit cwd for POST", () => {
    expect(resolveModelCatalogCwd({
      method: "GET",
      requestedCwd: "/tmp/untrusted",
      sessionCwd: "/work/session-project",
    })).toBe("/work/session-project");
    expect(resolveModelCatalogCwd({
      method: "POST",
      requestedCwd: "/work/new-project",
      sessionCwd: null,
    })).toBe("/work/new-project");
  });
});
