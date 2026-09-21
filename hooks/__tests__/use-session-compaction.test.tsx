// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionCompaction } from "../use-session-compaction";
import type { CompactionState } from "@/lib/compaction-state";
import { resetCompactionNoticeCache } from "@/lib/compaction-notices";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/agent-client", () => ({ sendAgentCommand: transport.send }));
let api: ReturnType<typeof useSessionCompaction>;
let active = false;
const complete = vi.fn();
const connect = vi.fn().mockResolvedValue(true);
function Harness({ sessionId = "session" }: { sessionId?: string }) {
  const sid = useRef<string | null>(sessionId);
  const [running, setRunning] = useState(false);
  const value = useSessionCompaction(sid, setRunning, complete, connect);
  useEffect(() => { active = running; api = value; }, [running, value]);
  return <input aria-label="draft" />;
}
let root: Root;
let container: HTMLDivElement;
async function render() {
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
}
const job = (status: CompactionState["status"], id = "job"): CompactionState => ({ id, status, reason: "manual", startedAt: 1 });
const stateResponse = (compaction: CompactionState | null) => ({ ok: true, json: async () => ({ running: true, state: { compaction, isCompacting: compaction?.status === "running", compactionQueue: [] } }) });
beforeEach(() => { localStorage.clear(); resetCompactionNoticeCache(); });
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("compaction client reconciliation", () => {
  it("returns on acceptance, leaves editing available, and completes only from server evidence", async () => {
    transport.send.mockImplementation(async (_sid, command) => job("running", command.requestId));
    await render();
    await act(async () => api.start("keep decisions"));
    expect(active).toBe(true);
    expect(container.querySelector("input")?.disabled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    const id = api.view!.id;
    await act(async () => api.handleEvent({ type: "compaction_status", compaction: job("completed", id) }));
    expect(active).toBe(false);
    expect(complete).toHaveBeenCalledOnce();
    await act(async () => api.reconcile({ compaction: job("running", id) }));
    expect(api.view?.status).toBe("completed");
  });

  it("reconciles a lost acceptance response without repeating the POST", async () => {
    transport.send.mockImplementation(async (_sid, command) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse(job("completed", command.requestId))));
      throw new Error("Network lost");
    });
    await render(); await act(async () => api.start());
    expect(api.view?.status).toBe("completed");
    expect(transport.send).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not turn completion into failure if POST fails after SSE completion", async () => {
    transport.send.mockImplementation(async (_sid, command) => {
      api.handleEvent({ type: "compaction_status", compaction: job("completed", command.requestId) });
      throw new Error("Disconnected");
    });
    await render(); await act(async () => api.start());
    expect(api.view?.status).toBe("completed");
  });

  it("shows unknown, not success, after a runtime loses an accepted job", async () => {
    transport.send.mockImplementation(async (_sid, command) => job("running", command.requestId));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse(null)));
    await render(); await act(async () => api.start());
    await act(async () => api.check());
    expect(api.view?.status).toBe("unknown");
    expect(active).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("keeps cancellation pending until the server confirms it", async () => {
    transport.send.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse(job("running"))));
    await render(); await act(async () => api.reconcile({ compaction: job("running") }));
    await act(async () => api.abort()); expect(active).toBe(true);
    await act(async () => api.handleEvent({ type: "compaction_status", compaction: job("cancelled") }));
    expect(active).toBe(false); expect(api.view?.status).toBe("cancelled");
  });

  it("classifies Pi no-op outcomes neutrally and ignores duplicate legacy events", async () => {
    await render();
    await act(async () => api.handleEvent({ type: "compaction_end", errorMessage: "Already compacted" }));
    expect(api.view?.status).toBe("skipped");
    await act(async () => api.handleEvent({ type: "compaction_start", webManaged: true }));
    expect(api.view?.status).toBe("skipped");
    await act(async () => api.handleEvent({ type: "session_compact_failed", error: "429 limited" }));
    expect(api.view).toMatchObject({ status: "failed", error: "429 limited" });
  });

  it("preserves image and steer intent and keeps drafts when sending is unconfirmed", async () => {
    transport.send.mockResolvedValue({ queued: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse(job("running"))));
    await render(); await act(async () => api.reconcile({ compaction: job("running") }));
    let accepted;
    await act(async () => { accepted = await api.enqueue("look", [{ previewUrl: "", data: "aGVsbG8=", mimeType: "image/png" }], "steer"); });
    expect(accepted).toBe(true);
    expect(transport.send).toHaveBeenCalledWith("session", expect.objectContaining({ type: "queue_compaction_prompt", mode: "steer", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] }));
    transport.send.mockRejectedValue(new Error("offline"));
    await act(async () => { accepted = await api.enqueue("keep draft"); });
    expect(accepted).toBe(false);
  });

  it("does not resurrect dismissed terminal notices during snapshot replay", async () => {
    await render(); await act(async () => api.reconcile({ compaction: job("skipped") }));
    await act(async () => api.dismiss());
    await act(async () => api.reconcile({ compaction: job("skipped") }));
    expect(api.view).toBeNull();
  });

  it("hides success after five seconds even when snapshots keep replaying", async () => {
    vi.useFakeTimers();
    await render(); await act(async () => api.reconcile({ compaction: job("completed") }));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(api.view?.status).toBe("completed");
    await act(async () => api.reconcile({ compaction: job("completed") }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.view).toBeNull();
    await act(async () => api.reconcile({ compaction: job("completed") }));
    expect(api.view).toBeNull();
    expect(complete).toHaveBeenCalledOnce();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not redisplay success after remount/reload (manually dismissed=%s)", async (manuallyDismissed) => {
    await render(); await act(async () => api.reconcile({ compaction: job("completed") }));
    if (manuallyDismissed) await act(async () => api.dismiss());
    // Clear module memory too: browser storage must survive a fresh document.
    resetCompactionNoticeCache();
    await act(async () => root.render(<Harness key="returned" />));
    await act(async () => api.reconcile({ compaction: job("completed") }));
    expect(api.view).toBeNull();
    // Suppress the notice, not the context refresh in a newly mounted view.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("shows a new operation and does not let the old success timer hide it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse(job("running", "next-job"))));
    await render(); await act(async () => api.reconcile({ compaction: job("completed") }));
    await act(async () => vi.advanceTimersByTime(4000));
    await act(async () => api.reconcile({ compaction: job("running", "next-job") }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.view).toMatchObject({ id: "next-job", status: "running" });
    await act(async () => api.reconcile({ compaction: job("completed", "next-job") }));
    expect(api.view?.status).toBe("completed");
    await act(async () => vi.advanceTimersByTime(5000));
    expect(api.view).toBeNull();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not share a job receipt with a different session", async () => {
    await render(); await act(async () => api.reconcile({ compaction: job("completed") }));
    await act(async () => api.dismiss());
    await act(async () => root.render(<Harness key="other" sessionId="other-session" />));
    await act(async () => api.reconcile({ compaction: job("completed") }));
    expect(api.view?.status).toBe("completed");
  });

  it("leaves failures and queued prompts visible after the success timeout", async () => {
    vi.useFakeTimers();
    await render(); await act(async () => api.reconcile({ compaction: job("completed"), compactionQueue: [{ id: "pending", message: "keep me" }] }));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(api.view).toBeNull();
    expect(api.queue).toEqual([{ id: "pending", message: "keep me" }]);
    await act(async () => api.reconcile({ compaction: job("failed", "failure") }));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.view).toMatchObject({ id: "failure", status: "failed" });
    await act(async () => root.render(<Harness key="return-to-failure" />));
    await act(async () => api.reconcile({ compaction: job("failed", "failure") }));
    expect(api.view?.status).toBe("failed");
  });

  it("keeps an unknown outcome visible until the user dismisses it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse(null)));
    await render(); await act(async () => api.reconcile({ compaction: job("running") }));
    await act(async () => api.check());
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(api.view?.status).toBe("unknown");
  });

  it("does not hide a corrected failure after an earlier result was dismissed", async () => {
    await render(); await act(async () => api.reconcile({ compaction: job("skipped") }));
    await act(async () => api.dismiss());
    await act(async () => root.render(<Harness key="reloaded" />));
    await act(async () => api.reconcile({ compaction: job("skipped") }));
    expect(api.view).toBeNull();
    await act(async () => api.reconcile({ compaction: job("failed") }));
    expect(api.view?.status).toBe("failed");
  });

  it("clears an in-progress view when another view has already displayed its result", async () => {
    await render(); await act(async () => api.reconcile({ compaction: job("completed") }));
    await act(async () => root.render(<Harness key="other-view" />));
    await act(async () => api.reconcile({ compaction: job("running") }));
    expect(active).toBe(true);
    await act(async () => api.reconcile({ compaction: job("completed") }));
    expect(active).toBe(false); expect(api.view).toBeNull();
  });
});
