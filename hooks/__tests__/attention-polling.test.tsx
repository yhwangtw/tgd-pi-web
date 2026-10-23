// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAttentionCenter } from "../useAttentionCenter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shares one poller, skips unchanged inbox emissions, and pauses while hidden", async () => {
  vi.useFakeTimers();
  let visibility = "visible"; let title = "First";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "one", source: "session", status: "failed", severity: "error", title, summary: "Failed", occurredAt: "2026-10-23" }], serverTime: new Date().toISOString() })));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); const root = createRoot(host);
  let renders = 0;
  function Panel() { const attention = useAttentionCenter(); renders += 1; return <span>{attention.items[0]?.title}</span>; }
  try {
    await act(async () => root.render(<><Panel /><Panel /></>));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const before = renders;
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(renders).toBe(before);
    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(45_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    visibility = "visible"; title = "Updated";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe("UpdatedUpdated");
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
