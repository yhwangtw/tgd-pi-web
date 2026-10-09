// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../types";
let state: typeof import("../session-read-state");
const modified = "2026-09-27T01:00:00.000Z";
const session: SessionInfo = { id: "one", path: "", cwd: "/fixture", modified, created: modified, messageCount: 2, firstMessage: "hello", lastMessageId: "answer" };
beforeEach(async () => { vi.resetModules(); localStorage.clear(); state = await import("../session-read-state"); });
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
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
