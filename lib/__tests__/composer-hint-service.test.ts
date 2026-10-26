import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), find: vi.fn(), auth: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: mocks.complete }));
vi.mock("../pi-model-runtime", () => ({ createPiModelRegistry: async () => ({ registry: {
  find: mocks.find, getError: () => null, getApiKeyAndHeaders: mocks.auth,
} }) }));
import { generateComposerHint } from "../composer-hint-service";

let serial = 0;
const request = () => ({ provider: "fixture", modelId: `model-${serial++}`, locale: "zh" as const,
  messages: [{ role: "user" as const, text: "修復預覽" }, { role: "assistant" as const, text: "已修復，下一步測試手機版" }] });
const signal = () => new AbortController().signal;
beforeEach(() => {
  mocks.complete.mockReset(); mocks.find.mockReset(); mocks.auth.mockReset();
  mocks.find.mockReturnValue({ id: "one", provider: "fixture" });
  mocks.auth.mockResolvedValue({ ok: true, apiKey: "in-memory-fixture", headers: { "x-fixture": "one" } });
  mocks.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "幫我驗證手機版的檔案預覽" }] });
});
describe("bounded background suggestion generation", () => {
  it("uses the selected provider and one tool-free, non-retrying completion, then caches it", async () => {
    const body = request();
    expect(await generateComposerHint(body, signal())).toBe("幫我驗證手機版的檔案預覽");
    await generateComposerHint(body, signal());
    expect(mocks.find).toHaveBeenCalledWith(body.provider, body.modelId);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const [, context, options] = mocks.complete.mock.calls[0];
    expect(context.messages).toHaveLength(1);
    expect(context.tools).toBeUndefined();
    expect(context.messages[0].content).toContain("手機版");
    expect(options).toMatchObject({ maxTokens: 120, maxRetries: 0, timeoutMs: 6000, cacheRetention: "none" });
    expect(options.reasoning).toBeUndefined();
  });
  it("coalesces duplicate requests and limits simultaneous background work", async () => {
    const finish: Array<(result: unknown) => void> = [];
    mocks.complete.mockImplementation(() => new Promise(resolve => { finish.push(resolve); }));
    const a = request();
    const first = generateComposerHint(a, signal());
    const duplicate = generateComposerHint(a, signal());
    const second = generateComposerHint(request(), signal());
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    expect(await generateComposerHint(request(), signal())).toBeNull();
    finish.forEach(resolve => resolve({ stopReason: "stop", content: [{ type: "text", text: "Test the preview" }] }));
    expect(await Promise.all([first, duplicate, second])).toEqual(Array(3).fill("Test the preview"));
  });
  it("caches provider errors quietly and never forwards credential-bearing errors", async () => {
    const body = request();
    mocks.complete.mockRejectedValue(new Error("private-provider-key"));
    expect(await generateComposerHint(body, signal())).toBeNull();
    expect(await generateComposerHint(body, signal())).toBeNull();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("skips unavailable models and already-aborted requests without provider traffic", async () => {
    mocks.find.mockReturnValue(undefined);
    expect(await generateComposerHint(request(), signal())).toBeNull();
    const controller = new AbortController(); controller.abort();
    expect(await generateComposerHint(request(), controller.signal)).toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
