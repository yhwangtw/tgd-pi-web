// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../types";
let state: typeof import("../session-read-state");
const modified = "2026-09-27T01:00:00.000Z";
const session: SessionInfo = { id: "one", path: "", cwd: "/fixture", modified, created: modified, messageCount: 2, firstMessage: "hello", lastMessageId: "answer" };
beforeEach(async () => { vi.resetModules(); localStorage.clear(); state = await import("../session-read-state"); });
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("marks new content unread, advances read progress monotonically, and keeps future replies unread", () => {
  expect(state.isSessionUnread(session)).toBe(true);
  const listener = vi.fn(); const stop = state.subscribeSessionReads(listener);
  state.markSessionRead(session.id, Date.parse(modified), "answer");
  expect(state.isSessionUnread(session)).toBe(false); expect(listener).toHaveBeenCalledOnce();
  state.markSessionRead(session.id, Date.parse(modified) - 1000);
  expect(state.isSessionUnread(session)).toBe(false);
  expect(state.isSessionUnread({ ...session, lastMessageId: "later", modified: "2026-09-27T01:00:01.000Z" })).toBe(true);
  stop();
});
it("reuses existing transcript receipts and excludes empty/ephemeral conversations", () => {
  localStorage.setItem("pi-last-read:one", "answer");
  expect(state.isSessionUnread(session)).toBe(false);
  expect(state.isSessionUnread({ ...session, lastMessageId: "later" })).toBe(true);
  expect(state.isSessionUnread({ ...session, messageCount: 0 })).toBe(false);
  expect(state.isSessionUnread({ ...session, ephemeral: true })).toBe(false);
});
it("notifies other mounted views of same-tab and cross-tab reads, then unsubscribes", () => {
  const listener = vi.fn(); const stop = state.subscribeSessionReads(listener);
  state.markSessionRead("one", 0, "answer");
  expect(listener).toHaveBeenCalledTimes(1);
  localStorage.setItem("pi-session-read:one", String(Date.parse(modified)));
  window.dispatchEvent(new StorageEvent("storage", { key: "pi-session-read:one" }));
  expect(listener).toHaveBeenCalledTimes(2); expect(state.isSessionUnread(session)).toBe(false);
  stop(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(listener).toHaveBeenCalledTimes(2);
});
it("continues in memory when storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  state.markSessionRead("one", Date.parse(modified), "answer");
  expect(state.isSessionUnread(session)).toBe(false);
});

it("reuses source receipts after automatic conversion while new native replies stay unread", () => {
  state.markSessionRead("old", Date.parse(modified), "answer");
  const migrated = { ...session, id: "dw_new", sourceSessionId: "old" };
  expect(state.isSessionUnread(migrated)).toBe(false);
  expect(state.isSessionUnread({ ...migrated, modified: "2026-09-27T01:00:01.000Z", lastMessageId: "durable:2" })).toBe(true);
});

it("never moves the cursor backwards when older content is viewed", () => {
  state.markSessionRead("one", 2000, "new");
  state.markSessionRead("one", 1000, "old");
  expect(state.getSessionReadReceipt("one")).toEqual({ timestamp: 2000, entryId: "new" });
  state.markSessionRead("one", 2000, "old");
  expect(state.getSessionReadReceipt("one")?.entryId).toBe("new");
});
it("orders tied timestamps by known transcript order and keeps new same-time replies unread", () => {
  state.markSessionRead("one", Date.parse(modified), "question");
  expect(state.isSessionUnread(session)).toBe(true);
  state.markSessionRead("one", Date.parse(modified), "answer", ["question", "answer"]);
  expect(state.isSessionUnread(session)).toBe(false);
  state.markSessionRead("one", Date.parse(modified), "question", ["question", "answer"]);
  expect(state.getSessionReadReceipt("one")?.entryId).toBe("answer");
});
it("hydrates server reads without regressing on delayed snapshots and isolates backend stores", () => {
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: { one: { timestamp: 2000, entryId: "new", position: 4 } } });
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: { one: { timestamp: 1000, entryId: "old", position: 2 } } });
  expect(state.getSessionReadReceipt("one")?.entryId).toBe("new");
  state.mergeSessionReadSnapshot({ scope: "preview", receipts: {} });
  expect(state.getSessionReadReceipt("one")).toBeUndefined();
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  expect(state.getSessionReadReceipt("one")?.entryId).toBe("new");
});
it("coalesces writes, sends only IDs and retries a failed sync on the next list refresh", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true, json: async () => ({ scope: "prod", receipts: { one: { timestamp: 2000, entryId: "new", position: 4 } } }) });
  vi.stubGlobal("fetch", fetch);
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  state.markSessionRead("one", 1000, "old");
  state.markSessionRead("one", 2000, "new");
  await vi.advanceTimersByTimeAsync(400);
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ scope: "prod", receipts: [{ id: "one", entryId: "new" }] });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetch).toHaveBeenCalledOnce();
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  await vi.advanceTimersByTimeAsync(400);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(state.getSessionReadReceipt("one")).toEqual({ timestamp: 2000, entryId: "new", position: 4 });
});
it("retains a newer cursor queued while the previous write is in flight", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ scope: "prod", receipts: {} }) });
  vi.stubGlobal("fetch", fetch);
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  state.markSessionRead("one", 1000, "old");
  await vi.advanceTimersByTimeAsync(400);
  state.markSessionRead("one", 2000, "new");
  finish({ ok: true, json: async () => ({ scope: "prod", receipts: { one: { timestamp: 1000, entryId: "old", position: 2 } } }) });
  await vi.advanceTimersByTimeAsync(400);
  expect(state.getSessionReadReceipt("one")?.entryId).toBe("new");
  expect(JSON.parse(fetch.mock.calls[1][1].body).receipts[0].entryId).toBe("new");
});

it("preserves legacy maximum timestamps even if old scrolling corrupted the entry marker", () => {
  localStorage.setItem("pi-session-read:one", String(Date.parse(modified)));
  localStorage.setItem("pi-last-read:one", "older-question");
  expect(state.isSessionUnread(session)).toBe(false);
  expect(state.getSessionReadReceipt("one")?.entryId).toBeUndefined();
});
it("resolves a local cursor's position to converge with a newer same-time read from another device", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scope: "prod", receipts: { one: { timestamp: 1000, entryId: "b", position: 3 } } }) });
  vi.stubGlobal("fetch", fetch);
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  state.markSessionRead("one", 1000, "a");
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: { one: { timestamp: 1000, entryId: "b", position: 3 } } });
  await vi.advanceTimersByTimeAsync(400);
  expect(state.getSessionReadReceipt("one")).toEqual({ timestamp: 1000, entryId: "b", position: 3 });
});
it("restores offline pending writes after reload even without revisiting that conversation", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetch);
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} }); state.markSessionRead("one", 1000, "a");
  await vi.advanceTimersByTimeAsync(400);
  vi.resetModules(); state = await import("../session-read-state");
  fetch.mockResolvedValue({ ok: true, json: async () => ({ scope: "prod", receipts: { one: { timestamp: 1000, entryId: "a", position: 1 } } }) });
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  await vi.advanceTimersByTimeAsync(400);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem("pi-session-read-outbox:prod:one")).toBeNull();
});

it("waits for backend identity before enabling a first-visit read tracker", () => {
  state.mergeSessionReadSnapshot();
  expect(state.hasSessionReadSnapshot()).toBe(false);
  state.mergeSessionReadSnapshot({ scope: "prod", receipts: {} });
  expect(state.hasSessionReadSnapshot()).toBe(true);
  state.mergeSessionReadSnapshot(); // A temporary outage keeps the established backend.
  expect(state.hasSessionReadSnapshot()).toBe(true);
});
