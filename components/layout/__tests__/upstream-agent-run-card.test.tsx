// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/lib/agent-run-types";
import { AgentRunCard } from "../AgentRunCard";
import { AgentBudgetSettings } from "../AgentBudgetSettings";
import { AgentDashboardPanel } from "../AgentDashboardPanel";
import { resetRequestState } from "@/lib/request-state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const run: AgentRun = {
  id: "upstream-test", engine: "upstream", name: "Reviewer", cwd: "/work", prompt: "", toolNames: [],
  trigger: "subagent", status: "running", createdAt: "2026-10-23T01:00:00Z", parentSessionId: "parent-1",
  upstream: { asyncId: "async-1", state: "running", canStop: true, canRetry: false },
};

describe("upstream agent run presentation", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  async function render(component: React.ReactNode) {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(component));
    return container;
  }
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove(); root = undefined; container = undefined;
    resetRequestState(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it("offers stop and the owning parent chat without unsupported budget or transcript controls", async () => {
    const open = vi.fn(); const cancel = vi.fn();
    const view = await render(<AgentRunCard run={run} busy={false} onCancel={cancel} onRetry={vi.fn()} onExtend={vi.fn()} onOpenSession={open} />);
    expect(view.textContent).toContain("Pi Subagents");
    const buttons = [...view.querySelectorAll("button")];
    expect(buttons.some(button => button.textContent === "Extend budgets · +30 min")).toBe(false);
    expect(buttons.some(button => button.textContent === "View activity")).toBe(false);
    await act(async () => buttons.find(button => button.textContent === "Open parent chat")!.click());
    expect(open).toHaveBeenCalledWith("parent-1");
    await act(async () => buttons.find(button => button.textContent === "Cancel")!.click());
    expect(cancel).toHaveBeenCalledWith(run);
    expect(view.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("keeps activity, session, retry and budget controls available for SDK runs", async () => {
    const sdk: AgentRun = { id: "sdk-run", name: "SDK review", cwd: "/work", prompt: "Review", toolNames: ["read"], trigger: "manual", status: "running", createdAt: run.createdAt, sessionId: "dw_saved-sdk-id" };
    const open = vi.fn();
    const view = await render(<AgentRunCard run={sdk} busy={false} onCancel={vi.fn()} onRetry={vi.fn()} onExtend={vi.fn()} onOpenSession={open} />);
    expect(view.textContent).not.toContain("Pi Subagents");
    const buttons = [...view.querySelectorAll("button")];
    expect(buttons.some(button => button.textContent === "View activity")).toBe(true);
    expect(buttons.some(button => button.textContent === "Extend budgets · +30 min")).toBe(true);
    await act(async () => buttons.find(button => button.textContent === "Open session")!.click());
    expect(open).toHaveBeenCalledWith("dw_saved-sdk-id");
    await act(async () => root?.render(<AgentRunCard run={{ ...sdk, status: "failed" }} busy={false} onCancel={vi.fn()} onRetry={vi.fn()} onOpenSession={open} />));
    expect([...view.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true);
  });

  it("shows the actual paused state and hides retry when the snapshot has no recovery details", async () => {
    const value = { ...run, status: "interrupted" as const, upstream: { ...run.upstream!, state: "paused" as const } };
    const view = await render(<AgentRunCard run={value} busy={false} onCancel={vi.fn()} onRetry={vi.fn()} onOpenSession={vi.fn()} />);
    expect(view.textContent).toContain("Paused");
    expect([...view.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(false);
    expect([...view.querySelectorAll("button")].some(button => button.textContent === "Cancel")).toBe(true);
  });

  it("labels retained status and acknowledged stop without reporting completion", async () => {
    const value = { ...run, upstream: { ...run.upstream!, statusStale: true, stopRequested: true, canStop: false } };
    const view = await render(<AgentRunCard run={value} busy={false} onCancel={vi.fn()} onRetry={vi.fn()} onOpenSession={vi.fn()} />);
    expect(view.textContent).toContain("last known status");
    expect(view.textContent).toContain("waiting for confirmation");
    expect(view.querySelector('[data-status="running"]')).not.toBeNull();
    expect([...view.querySelectorAll("button")].some(button => button.textContent === "Cancel")).toBe(false);
  });

  it("labels the queue and budget controls with their execution scope", async () => {
    const view = await render(<AgentBudgetSettings limits={{ maxTurns: 4 }} maxConcurrency={3} onSaved={vi.fn()} />);
    expect(view.textContent).toContain("Legacy child limits");
    expect(view.textContent).toContain("Pi Subagents does not support these saved limits");
    expect(view.textContent).toContain("Pi Subagents manages its own concurrency");
  });

  it("shows saved-limit reconciliation even when no upstream host could load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      runs: [], maxConcurrency: 3, subagentLimits: { maxTurns: 4 },
      upstreamStatus: { partial: false, scope: "active_and_cached_sessions", delegationBlockedBySavedLimits: true },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const view = await render(<AgentDashboardPanel defaultCwd="/work" onOpenSession={vi.fn()} />);
    expect(view.querySelector('[data-testid="upstream-run-limits-blocked"]')?.textContent).toContain("Existing limits are preserved");
    expect(view.querySelector('select[aria-label="Manual queue concurrent slots"]')).not.toBeNull();
  });

  it("shows a partial-read notice even when no upstream card was available to cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      runs: [], maxConcurrency: 3, upstreamStatus: { partial: true, unavailableHosts: 1, scope: "active_and_cached_sessions" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const view = await render(<AgentDashboardPanel defaultCwd="/work" onOpenSession={vi.fn()} />);
    expect(view.querySelector('[data-testid="upstream-run-partial"]')?.textContent).toContain("unavailable or omitted");
    expect(view.querySelector('[data-testid="upstream-run-scope"]')?.textContent).toContain("other chats may not be listed");
  });
});
