// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRequestState } from "@/lib/request-state";
import { AgentDashboardPanel } from "../AgentDashboardPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AgentDashboardPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    resetRequestState();
    vi.restoreAllMocks();
  });

  it("AC-4.4: adjusts the persisted concurrent agent slots from 1 through 8", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return json({ maxConcurrency: 5 });
      }
      return json({
        runs: [],
        counts: {},
        maxConcurrency: 3,
        serverTime: "2026-07-26T06:00:00.000Z",
        nextCursor: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<AgentDashboardPanel defaultCwd="/tmp/project" onOpenSession={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Manual queue concurrent slots"]');
    expect(select).not.toBeNull();
    expect(select!.value).toBe("3");
    expect([...select!.options].map((option) => option.value)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);

    await act(async () => {
      select!.value = "5";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/agent-runs", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ maxConcurrency: 5 }),
    }));
    expect(select!.value).toBe("5");
  });

  it("distinguishes a filtered empty list and restores completed history with Clear filters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      runs: [{ id: "done", name: "Completed fixture", cwd: "/fixture", prompt: "Test", status: "completed", createdAt: "2026-10-10T00:00:00Z" }],
      maxConcurrency: 3,
    })));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<AgentDashboardPanel defaultCwd="/fixture" onOpenSession={vi.fn()} />));
    expect(container.textContent).toContain("Completed fixture");
    const active = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "0Active")!;
    expect(active.getAttribute("aria-pressed")).toBe("false");
    await act(async () => active.click());
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("No matching runs");
    expect(container.textContent).not.toContain("No background runs yet");
    const clear = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Clear filters")!;
    await act(async () => clear.click());
    expect(active.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Completed fixture");
    expect(container.textContent).not.toContain("No matching runs");
  });
});
