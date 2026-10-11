// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SessionInfo } from "@/lib/types";
import { useAppShellState } from "../useAppShellState";

const fixture = vi.hoisted(() => ({
  replace: vi.fn(),
  snapshot: { allSessions: [] as SessionInfo[], loading: false, error: null },
  listeners: new Set<() => void>(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: fixture.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/session-list-store", () => ({
  getSessionListSnapshot: () => fixture.snapshot,
  getServerSessionListSnapshot: () => fixture.snapshot,
  subscribeSessionList: (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  },
  rememberNewSession: vi.fn(), forgetSession: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("updates main and parallel names without resetting the transcript or navigating", async () => {
  const session = (id: string, name: string): SessionInfo => ({ id, name, cwd: "/fixture", path: "", created: "", modified: "", firstMessage: "", messageCount: 1 });
  let current!: ReturnType<typeof useAppShellState>;
  function Harness() {
    const value = useAppShellState();
    useEffect(() => { current = value; }, [value]);
    return null;
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      current.actions.handleSelectSession(session("main", "Old main"));
      current.actions.openParallel(session("side", "Old side"));
    });
    const sessionKey = current.state.sessionKey;
    fixture.replace.mockClear();
    await act(async () => {
      fixture.snapshot = { ...fixture.snapshot, allSessions: [session("main", "New main"), session("side", "New side")] };
      fixture.listeners.forEach(listener => listener());
    });
    expect(current.state.selectedSession?.name).toBe("New main");
    expect(current.state.parallelSessions[0].name).toBe("New side");
    expect(current.state.sessionKey).toBe(sessionKey);
    expect(fixture.replace).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); container.remove(); fixture.listeners.clear();
  }
});
