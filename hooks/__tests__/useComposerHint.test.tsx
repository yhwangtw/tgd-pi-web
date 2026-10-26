// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerHint } from "../useComposerHint";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let serial = 0;
let sessionKey: string;
const fetchHint = vi.fn();
const answer = (hint: string | null, extra = {}) => new Response(JSON.stringify({ hint, ...extra }));
function Probe({ idle = true, turnKey = "turn-one", active = true }: { idle?: boolean; turnKey?: string; active?: boolean }) {
  const state = useComposerHint({ sessionKey, idle, turnKey, model: { provider: "fixture", modelId: "one" }, locale: "en",
    messages: active ? [{ role: "user", text: sessionKey }, { role: "assistant", text: "Test mobile next" }] : null });
  return <><output>{state.hint ?? ""}</output><button onClick={() => state.setEnabled(false)}>Disable</button></>;
}
const render = async (props = {}, copies = 1) => { await act(async () => root.render(<>{Array.from({ length: copies }, (_, i) => <Probe key={i} {...props} />)}</>)); };
const tick = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
const text = () => container.querySelector("output")!.textContent;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); sessionKey = `retry-session-${serial++}`;
  fetchHint.mockReset(); fetchHint.mockImplementation(async () => answer(null)); vi.stubGlobal("fetch", fetchHint);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("suggestion retry scheduling", () => {
  it.each(["empty", "network"])("recovers from %s on the next attempt without typing or refreshing", async kind => {
    if (kind === "empty") fetchHint.mockResolvedValueOnce(answer(null, { status: "empty", retryable: true, retryAfterMs: 2000 }));
    else fetchHint.mockRejectedValueOnce(new TypeError("offline"));
    fetchHint.mockResolvedValue(answer("Test the mobile preview"));
    await render(); await tick(700);
    expect(text()).toBe(""); expect(fetchHint).toHaveBeenCalledTimes(1);
    await tick(1999); expect(fetchHint).toHaveBeenCalledTimes(1);
    await tick(1); expect(text()).toBe("Test the mobile preview"); expect(fetchHint).toHaveBeenCalledTimes(2);
  });
  it("stops after the initial request and two retries with increasing backoff", async () => {
    await render(); await tick(700);
    expect(fetchHint).toHaveBeenCalledTimes(1);
    await tick(2000); expect(fetchHint).toHaveBeenCalledTimes(2);
    await tick(3999); expect(fetchHint).toHaveBeenCalledTimes(2);
    await tick(1); expect(fetchHint).toHaveBeenCalledTimes(3);
    await tick(120_000); expect(fetchHint).toHaveBeenCalledTimes(3);
    expect(text()).toBe("");
  });
  it("shares retry work across panes displaying the same turn", async () => {
    await render({}, 2); await tick(700); expect(fetchHint).toHaveBeenCalledTimes(1);
    fetchHint.mockResolvedValue(answer("Check the mobile view"));
    await tick(2000); expect(fetchHint).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("output")[1].textContent).toBe("Check the mobile view");
  });
  it("pauses retries while editing or running and resumes the remaining budget when idle", async () => {
    await render(); await tick(700);
    await render({ idle: false }); await tick(10_000);
    expect(fetchHint).toHaveBeenCalledTimes(1);
    fetchHint.mockResolvedValue(answer("Continue with verification"));
    await render(); await tick(700);
    expect(fetchHint).toHaveBeenCalledTimes(2); expect(text()).toBe("Continue with verification");
  });
  it("cancels scheduled retries when suggestions are disabled", async () => {
    await render(); await tick(700);
    await act(async () => container.querySelector("button")!.click());
    await tick(10_000); expect(fetchHint).toHaveBeenCalledTimes(1); expect(text()).toBe("");
  });
  it("does not retry unavailable models or rejected browser requests", async () => {
    fetchHint.mockResolvedValue(answer(null, { status: "unavailable", retryable: false }));
    await render(); await tick(20_000); expect(fetchHint).toHaveBeenCalledTimes(1);
  });
  it("gives a new completed turn a fresh evaluation even when its conversation text is identical", async () => {
    await render(); await tick(6700); expect(fetchHint).toHaveBeenCalledTimes(3);
    fetchHint.mockResolvedValue(answer("A fresh next step"));
    await render({ turnKey: "turn-two" }); await tick(700);
    expect(fetchHint).toHaveBeenCalledTimes(4); expect(text()).toBe("A fresh next step");
    const bodies = fetchHint.mock.calls.map(call => JSON.parse(call[1].body));
    expect(bodies[0].turnId).not.toBe(bodies[3].turnId);
  });
  it("ignores late empty output from a session that has been left and does not retry it", async () => {
    let finish!: (response: Response) => void;
    fetchHint.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await tick(700);
    await render({ active: false });
    await act(async () => { finish(answer(null)); });
    await tick(20_000); expect(fetchHint).toHaveBeenCalledTimes(1); expect(text()).toBe("");
  });
});
