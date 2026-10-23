// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { markSessionRead } from "@/lib/session-read-state";
import { resetRequestState } from "@/lib/request-state";
import { SessionSidebar } from "../SessionSidebar";

const fixture = vi.hoisted(() => ({
  sessions: ["read-fixture", "unread-fixture"].map(id => ({ id, path: `/fixture/${id}.jsonl`, cwd: "/fixture/project", name: id, firstMessage: id, messageCount: 2, created: "2026-10-01T00:00:00Z", modified: "2026-10-23T00:00:00Z" })),
  loadSessions: vi.fn(),
}));
vi.mock("@/hooks/useSessions", () => ({ useSessions: () => ({ allSessions: fixture.sessions, loading: false, error: null, pinnedIds: [], archivedIds: [], sessionRefreshDone: false, loadSessions: fixture.loadSessions, handlePinToggle: vi.fn(), handleArchiveToggle: vi.fn() }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); resetRequestState(); setLocale("en");
  markSessionRead("read-fixture", Date.parse("2026-10-23T00:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetRequestState(); vi.unstubAllGlobals(); });

it("clears an unread-only filter from the filter dialog and restores the read conversation", async () => {
  await act(async () => root.render(<SessionSidebar selectedSessionId={null} onSelectSession={vi.fn()} showExplorer={false} />));
  const rows = () => [...host.querySelectorAll('[role="row"]')].map(row => row.textContent);
  expect(rows().some(text => text?.includes("read-fixture"))).toBe(true);
  const unread = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(button => button.textContent?.includes("Unread"))!;
  await act(async () => unread.click());
  expect(unread.getAttribute("aria-pressed")).toBe("true");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toContain("unread-fixture");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Conversation filters"]')!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const clear = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Clear filters")!;
  expect(clear.disabled).toBe(false);
  await act(async () => clear.click());
  expect(clear.disabled).toBe(true);
  expect(unread.getAttribute("aria-pressed")).toBe("false");
  expect(rows()).toHaveLength(2);
});
