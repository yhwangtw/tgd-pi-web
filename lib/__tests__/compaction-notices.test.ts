// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasCompactionNoticeReceipt, rememberCompactionNotice, resetCompactionNoticeCache } from "../compaction-notices";

beforeEach(() => { localStorage.clear(); resetCompactionNoticeCache(); });
afterEach(() => { vi.restoreAllMocks(); });

it("reads receipts after a fresh page and keeps session, job and outcome separate", () => {
  rememberCompactionNotice("session", "job", "completed");
  resetCompactionNoticeCache();
  expect(hasCompactionNoticeReceipt("session", "job", "completed")).toBe(true);
  expect(hasCompactionNoticeReceipt("other", "job", "completed")).toBe(false);
  expect(hasCompactionNoticeReceipt("session", "next", "completed")).toBe(false);
  expect(hasCompactionNoticeReceipt("session", "job", "failed")).toBe(false);
});

it("keeps receipts in memory when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  rememberCompactionNotice("session", "job", "completed");
  expect(hasCompactionNoticeReceipt("session", "job", "completed")).toBe(true);
});

it("ignores corrupted storage and replaces it with usable receipts", () => {
  localStorage.setItem("pi-compaction-notices-v1", "invalid json");
  expect(hasCompactionNoticeReceipt("session", "job", "completed")).toBe(false);
  rememberCompactionNotice("session", "job", "completed");
  resetCompactionNoticeCache();
  expect(hasCompactionNoticeReceipt("session", "job", "completed")).toBe(true);
});

it("bounds retained history and keeps the newest results after reload", () => {
  for (let index = 0; index < 205; index++) rememberCompactionNotice("session", `job-${index}`, "completed");
  resetCompactionNoticeCache();
  expect(hasCompactionNoticeReceipt("session", "job-0", "completed")).toBe(false);
  expect(hasCompactionNoticeReceipt("session", "job-204", "completed")).toBe(true);
  expect(JSON.parse(localStorage.getItem("pi-compaction-notices-v1")!)).toHaveLength(200);
});
