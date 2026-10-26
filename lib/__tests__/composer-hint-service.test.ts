import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
afterEach(() => vi.restoreAllMocks());
describe("bounded background suggestion generation", () => {
  it("uses the selected provider and one tool-free, non-retrying completion, then caches it", async () => {
    const body = request();
    expect(await generateComposerHint(body, signal())).toMatchObject({ hint: "幫我驗證手機版的檔案預覽", status: "ready", retryable: false });
    await generateComposerHint(body, signal());
    expect(mocks.find).toHaveBeenCalledWith(body.provider, body.modelId);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const [, context, options] = mocks.complete.mock.calls[0];
    expect(context.messages).toHaveLength(1);
    expect(context.tools).toBeUndefined();
    expect(context.messages[0].content).toContain("手機版");
    expect(options).toMatchObject({ maxTokens: 120, maxRetries: 0, timeoutMs: 15_000, cacheRetention: "none" });
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
    expect(await generateComposerHint(request(), signal())).toMatchObject({ hint: null, status: "busy", retryable: true });
    finish.forEach(resolve => resolve({ stopReason: "stop", content: [{ type: "text", text: "Test the preview" }] }));
    for (const result of await Promise.all([first, duplicate, second])) expect(result).toMatchObject({ hint: "Test the preview", status: "ready" });
  });
  it("caches provider errors quietly and never forwards credential-bearing errors", async () => {
    const body = request();
    mocks.complete.mockRejectedValue(new Error("private-provider-key"));
    expect(await generateComposerHint(body, signal())).toMatchObject({ hint: null, status: "error", retryable: true });
    expect(await generateComposerHint(body, signal())).toMatchObject({ hint: null, status: "error", retryable: true });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("skips unavailable models and already-aborted requests without provider traffic", async () => {
    mocks.find.mockReturnValue(undefined);
    expect(await generateComposerHint(request(), signal())).toMatchObject({ hint: null, status: "unavailable", retryable: false });
    const controller = new AbortController(); controller.abort();
    expect(await generateComposerHint(request(), controller.signal)).toMatchObject({ hint: null, status: "error" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each(["empty", "error"])("retries %s results after short backoff and caps model work at three attempts", async kind => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const body = request();
    if (kind === "empty") mocks.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "NONE" }] });
    else mocks.complete.mockRejectedValue(new Error("private-provider-key"));
    const first = await generateComposerHint(body, signal());
    expect(first).toMatchObject({ hint: null, status: kind, retryable: true, retryAfterMs: 2000 });
    now += 1000;
    expect(await generateComposerHint(body, signal())).toMatchObject({ retryAfterMs: 1000 });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    now += 1001;
    expect(await generateComposerHint(body, signal())).toMatchObject({ retryable: true, retryAfterMs: 4000 });
    now += 4001;
    expect(await generateComposerHint(body, signal())).toMatchObject({ retryable: false });
    now += 10_000;
    await generateComposerHint(body, signal());
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    const serialized = JSON.stringify(await generateComposerHint(body, signal()));
    expect(serialized).not.toContain("private-provider-key");
  });
  it("recovers from empty output and gives identical text in a new turn a fresh budget", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const body = { ...request(), turnId: "session:turn-one" };
    mocks.complete.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "NONE" }] });
    expect(await generateComposerHint(body, signal())).toMatchObject({ status: "empty" });
    now += 2001;
    expect(await generateComposerHint(body, signal())).toMatchObject({ status: "ready" });
    await generateComposerHint(body, signal());
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    await generateComposerHint({ ...body, turnId: "session:turn-two" }, signal());
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    const [, context] = mocks.complete.mock.calls.at(-1)!;
    expect(JSON.stringify(context)).not.toContain("session:turn-two");
  });
  it.each([401, 402, 403, 404])("does not retry a permanent provider refusal (%s)", async status => {
    mocks.complete.mockImplementation(async (_model, _context, options) => {
      options.onResponse({ status });
      return { stopReason: "error", errorMessage: "private-provider-value", content: [] };
    });
    const body = request();
    expect(await generateComposerHint(body, signal())).toMatchObject({ status: "unavailable", retryable: false });
    await generateComposerHint(body, signal()); expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("retries an assistant-voice prediction and returns only a usable user request", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const body = request();
    mocks.complete.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "我會先測手機版。" }] })
      .mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "幫我測試手機版的排版。" }] });
    expect(await generateComposerHint(body, signal())).toMatchObject({ status: "empty", hint: null, retryable: true });
    now += 2001;
    expect(await generateComposerHint(body, signal())).toMatchObject({ status: "ready", hint: "幫我測試手機版的排版。" });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });
});
