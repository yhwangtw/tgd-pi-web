// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSchedule, ScheduleRun } from "@/lib/schedule-types";
import { resetRequestState } from "@/lib/request-state";
import { SchedulePanel } from "../SchedulePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schedule: AgentSchedule = {
  id: "schedule-1",
  name: "Daily review",
  cwd: "/tmp/project",
  prompt: "Review changes",
  timing: { kind: "daily", time: "09:00" },
  timezone: "Asia/Taipei",
  enabled: true,
  missedRunPolicy: "run_once",
  toolNames: ["read", "ask_user"],
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  nextRunAt: "2026-07-24T01:00:00.000Z",
  lastRunStatus: "waiting_for_input",
};

const waitingRun: ScheduleRun = {
  id: "run-1",
  scheduleId: schedule.id,
  scheduleName: schedule.name,
  trigger: "scheduled",
  scheduledFor: "2026-07-23T01:00:00.000Z",
  startedAt: "2026-07-23T01:00:00.000Z",
  status: "waiting_for_input",
  sessionId: "session-1",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("SchedulePanel", () => {
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

  async function renderPanel(fetchImpl: typeof fetch, onOpenSession = vi.fn()) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<SchedulePanel defaultCwd="/tmp/project" onOpenSession={onOpenSession} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    return { onOpenSession };
  }

  it("surfaces a waiting scheduled run and opens its normal Pi session", async () => {
    const { onOpenSession } = await renderPanel(async () => json({
      version: 1,
      schedules: [schedule],
      runs: [waitingRun],
      serverTime: "2026-07-23T01:01:00.000Z",
    }));

    expect(container!.textContent).toContain("Daily review");
    expect(container!.textContent).toContain("Waiting for input");
    const open = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Open session")!;
    await act(async () => open.click());
    expect(onOpenSession).toHaveBeenCalledWith("session-1");
  });

  it("opens the create form with the current project prefilled", async () => {
    await renderPanel(async () => json({ version: 1, schedules: [], runs: [], serverTime: "" }));
    const create = [...container!.querySelectorAll("button")].find((button) => button.textContent === "New schedule")!;
    await act(async () => create.click());
    expect(document.body.querySelector('[data-testid="schedule-editor"]')).not.toBeNull();
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="/path/to/project"]')?.value).toBe("/tmp/project");
    expect(document.body.textContent).toContain("Read-only");
  });

  it("starts a manual run through the schedule endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/run")) return json({ run: { ...waitingRun, status: "running" } }, 202);
      return json({ version: 1, schedules: [schedule], runs: [], serverTime: "" });
    });
    await renderPanel(fetchMock as typeof fetch);
    const runNow = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Run now")!;
    await act(async () => {
      runNow.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/schedules/schedule-1/run", expect.objectContaining({ method: "POST" }));
  });
});
