// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModelCatalog } from "../use-model-catalog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface DeferredResponse {
  resolve: (value: Response) => void;
  promise: Promise<Response>;
}

function deferredResponse(): DeferredResponse {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { resolve, promise };
}

function responseFor(provider: string, id: string): Response {
  return {
    ok: true,
    json: async () => ({
      models: { [`${provider}:${id}`]: id },
      modelList: [{ provider, id, name: id }],
      defaultModel: { provider, modelId: id },
    }),
  } as Response;
}

let catalog: ReturnType<typeof useModelCatalog>;

function Harness({ cwd, refreshKey = 0 }: { cwd: string; refreshKey?: number }) {
  const value = useModelCatalog(true, refreshKey, undefined, null, cwd);
  useEffect(() => { catalog = value; }, [value]);
  return <div data-testid="models">{Object.keys(value.modelNames).join(",")}</div>;
}

describe("useModelCatalog", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(cwd = "/workspace/first", refreshKey = 0) {
    if (!root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => root?.render(<Harness cwd={cwd} refreshKey={refreshKey} />));
  }

  it("distinguishes loading, empty, and failed catalogs and supports retry", async () => {
    const pending = deferredResponse();
    const fetchMock = vi.fn().mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(responseFor("test", "ready-model"));
    vi.stubGlobal("fetch", fetchMock);
    await render();
    expect(catalog.catalogStatus).toBe("loading");
    await act(async () => pending.resolve({ ok: true, json: async () => ({ models: {}, modelList: [], diagnostics: [{ type: "warning", message: "No provider credentials" }] }) } as Response));
    expect(catalog.catalogStatus).toBe("empty");
    expect(catalog.catalogDiagnostics).toEqual([{ type: "warning", message: "No provider credentials" }]);
    await act(async () => catalog.retryModelCatalog());
    expect(catalog.catalogStatus).toBe("error");
    expect(catalog.catalogError).toBe("HTTP 500");
    expect(catalog.newSessionModel).toBeNull();
    await act(async () => catalog.retryModelCatalog());
    expect(catalog.catalogStatus).toBe("ready");
    expect(catalog.newSessionModel).toEqual({ provider: "test", modelId: "ready-model" });
  });

  it("preserves a valid manual selection when the same catalog refreshes", async () => {
    const response = () => ({ ok: true, json: async () => ({ models: { "test:A": "A", "test:B": "B" }, modelList: [{ provider: "test", id: "A", name: "A" }, { provider: "test", id: "B", name: "B" }], defaultModel: { provider: "test", modelId: "A" } }) });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response()));
    await render();
    await act(async () => catalog.setNewSessionModel({ provider: "test", modelId: "B" }));
    await render("/workspace/first", 1);
    expect(catalog.newSessionModel).toEqual({ provider: "test", modelId: "B" });
  });

  it("clears source-bound data immediately and never exposes old choices after a cwd failure", async () => {
    const second = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(responseFor("old", "old-model")).mockReturnValueOnce(second.promise));
    await render();
    expect(catalog.newSessionModel?.modelId).toBe("old-model");
    await render("/workspace/second");
    expect(catalog.catalogStatus).toBe("loading");
    expect(catalog.modelList).toEqual([]);
    expect(catalog.modelNames).toEqual({});
    expect(catalog.newSessionModel).toBeNull();
    await act(async () => second.resolve({ ok: false, status: 500 } as Response));
    expect(catalog.catalogStatus).toBe("error");
    expect(catalog.modelList).toEqual([]);
    expect(catalog.newSessionModel).toBeNull();
  });

  it("reselects only when the chosen model disappears", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(responseFor("test", "old-model")).mockResolvedValueOnce(responseFor("test", "new-model")));
    await render();
    await render("/workspace/first", 1);
    expect(catalog.newSessionModel).toEqual({ provider: "test", modelId: "new-model" });
  });

  it("does not expose stale models after a refresh failure, but restores a still-valid choice on retry", async () => {
    const response = { ok: true, json: async () => ({ modelList: [{ provider: "test", id: "A", name: "A" }, { provider: "test", id: "B", name: "B" }], defaultModel: { provider: "test", modelId: "A" } }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce(response));
    await render();
    await act(async () => catalog.setNewSessionModel({ provider: "test", modelId: "B" }));
    await render("/workspace/first", 1);
    expect(catalog.catalogStatus).toBe("error");
    expect(catalog.modelList).toEqual([]);
    expect(catalog.newSessionModel).toBeNull();
    await act(async () => catalog.retryModelCatalog());
    expect(catalog.newSessionModel).toEqual({ provider: "test", modelId: "B" });
  });

  it("does not carry manual selection to a different source even with the same model ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ modelList: [{ provider: "test", id: "A", name: "A" }, { provider: "test", id: "B", name: "B" }], defaultModel: { provider: "test", modelId: "A" } }) })));
    await render();
    await act(async () => catalog.setNewSessionModel({ provider: "test", modelId: "B" }));
    await render("/workspace/second");
    expect(catalog.newSessionModel).toEqual({ provider: "test", modelId: "A" });
  });

  it("ignores an older catalog response after the cwd changes", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal("fetch", vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise));

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<Harness cwd="/workspace/first" />));
    await act(async () => root?.render(<Harness cwd="/workspace/second" />));

    await act(async () => second.resolve(responseFor("new-provider", "new-model")));
    expect(container.textContent).toBe("new-provider:new-model");

    await act(async () => first.resolve(responseFor("old-provider", "old-model")));
    expect(container.textContent).toBe("new-provider:new-model");
  });
});
