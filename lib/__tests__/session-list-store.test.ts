// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../types";

const session = (id: string): SessionInfo => ({ id, path: "", cwd: "/fixture", created: "2026-09-27T01:00:00Z", modified: "2026-09-27T01:00:00Z", messageCount: 1, firstMessage: id });
const response = (sessions: SessionInfo[]) => new Response(JSON.stringify({ sessions }));
let store: typeof import("../session-list-store");
let unsubscribe: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fetchMock = vi.fn().mockResolvedValue(response([])); vi.stubGlobal("fetch", fetchMock);
  store = await import("../session-list-store"); unsubscribe = [];
});
afterEach(() => { unsubscribe.forEach(stop => stop()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const subscribe = () => unsubscribe.push(store.subscribeSessionList(vi.fn()));

describe("live session list", () => {
  it("shares requests and polling, discovers external sessions, and stops when unmounted", async () => {
    subscribe(); subscribe();
    const first = store.refreshSessionList();
    expect(store.refreshSessionList()).toBe(first); await first;
    fetchMock.mockResolvedValue(response([session("external")]));
    await vi.advanceTimersByTimeAsync(store.SESSION_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSessionListSnapshot().allSessions[0].id).toBe("external");
    unsubscribe.splice(0).forEach(stop => stop());
    await vi.advanceTimersByTimeAsync(store.SESSION_POLL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queues invalidation behind a stale request without overlapping or losing a new session", async () => {
    subscribe();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    fetchMock.mockResolvedValue(response([session("new")]));
    const first = store.refreshSessionList();
    store.rememberNewSession(session("new"));
    expect(store.getSessionListSnapshot().allSessions[0].id).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(response([])); await first; await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSessionListSnapshot().allSessions.map(s => s.id)).toEqual(["new"]);
  });

  it("preserves unsaved conversations until persisted, without showing ephemeral sessions", async () => {
    subscribe();
    store.rememberNewSession(session("unsaved"));
    store.rememberNewSession({ ...session("private"), ephemeral: true });
    await store.refreshSessionList();
    expect(store.getSessionListSnapshot().allSessions.map(s => s.id)).toEqual(["unsaved"]);
    fetchMock.mockResolvedValue(response([{ ...session("unsaved"), name: "Persisted title" }]));
    await store.refreshSessionList();
    expect(store.getSessionListSnapshot().allSessions[0].name).toBe("Persisted title");
    fetchMock.mockResolvedValue(response([]));
    await store.refreshSessionList();
    expect(store.getSessionListSnapshot().allSessions).toEqual([]);
  });

  it("pauses background polls and refreshes immediately on visibility/focus/network recovery", async () => {
    subscribe(); await store.refreshSessionList();
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(store.SESSION_POLL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visible.mockReturnValue("visible");
    for (const [target, event] of [[document, "visibilitychange"], [window, "focus"], [window, "online"]] as const) {
      fetchMock.mockResolvedValue(response([session(event)]));
      target.dispatchEvent(new Event(event)); await vi.advanceTimersByTimeAsync(0);
      expect(store.getSessionListSnapshot().allSessions[0].id).toBe(event);
    }
  });

  it("keeps the last list on an error and recovers on the next poll", async () => {
    subscribe(); fetchMock.mockImplementation(async () => response([session("old")])); await store.refreshSessionList();
    fetchMock.mockRejectedValueOnce(new Error("offline")); await store.refreshSessionList();
    expect(store.getSessionListSnapshot().allSessions[0].id).toBe("old");
    expect(store.getSessionListSnapshot().error).toContain("offline");
    await vi.advanceTimersByTimeAsync(store.SESSION_POLL_MS);
    expect(store.getSessionListSnapshot().error).toBeNull();
  });
});
