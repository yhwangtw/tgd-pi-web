// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCenterStatus } from "@/lib/update-center";
import { UpdateCenterSection } from "../UpdateCenterSection";

const mocks = vi.hoisted(() => ({ status: null as UpdateCenterStatus | null, fetchJson: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/useRequestResource", () => ({ fetchJson: mocks.fetchJson, useRequestResource: () => ({ data: mocks.status, refresh: mocks.refresh, invalidate: mocks.invalidate }) }));
vi.mock("@/hooks/useToast", () => ({ showToast: mocks.toast }));
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ locale: "en", t: (key: string) => key }) }));
vi.mock("@/components/ui/DialogShell", () => ({ DialogShell: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <div role="dialog">{children}{footer}</div> : null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const operation = { id: "update-fixture", action: "restart" as const, status: "running" as const, pid: 200, cwd: "/fixture", createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  const ready = { configured: true, ready: true };
  mocks.status = {
    checkedAt: "2026-09-07T00:00:00Z", current: { version: "2026.09.07", source: "git", head: "a".repeat(40), branch: "main", dirty: false, changedFiles: 0, untrackedFiles: 0, sourceFingerprint: "fixture" },
    running: { pid: 100, startedAt: "2026-09-06T00:00:00Z", cwd: "/fixture", environment: "fixture", agentDir: "/fixture/agent", modelsPath: "/fixture/agent/models.json", build: { version: "2026.09.06", sourceSha: "b".repeat(40), dirty: false, builtAt: "2026-09-06T00:00:00Z" } },
    latest: { version: "2026.09.08", url: "https://example.invalid/release" }, updateAvailable: true,
    preflight: { ready: true, checks: [] }, backup: { root: "/fixture/backups", writable: true, recent: [] },
    actions: { backup: ready, update: ready, restart: ready, rollback: ready }, operations: { active: null, recent: [] },
    dataImpact: { preservesAgentData: true, sourceMayChange: true, requiresRestart: true }, commands: { update: "fixture", restart: "fixture", rollback: "fixture" },
  };
  mocks.refresh.mockImplementation(async () => mocks.status);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.useRealTimers(); });
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;

describe("persistent Update Center readback", () => {
  it("separates running build from disk source and restores active operations after reload", async () => {
    mocks.status!.operations = { active: operation, recent: [operation] };
    await act(async () => root.render(<UpdateCenterSection />));
    expect(container.textContent).toContain("updateCenter.runningBuild");
    expect(container.textContent).toContain("2026.09.06");
    expect(container.textContent).toContain("updateCenter.sourceCheckout");
    expect(container.textContent).toContain(operation.id);
    expect(container.textContent).toContain("updateCenter.operationStatus.running");
    expect(button("updateCenter.restartNow").disabled).toBe(true);
    expect(button("updateCenter.installUpdate").disabled).toBe(true);
  });
  it("polls an active operation and stops polling after durable completion", async () => {
    vi.useFakeTimers();
    mocks.status!.operations = { active: operation, recent: [operation] };
    await act(async () => root.render(<UpdateCenterSection />));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.status!.operations = { active: null, recent: [{ ...operation, status: "succeeded" }] };
    await act(async () => root.render(<UpdateCenterSection />));
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("updateCenter.operationStatus.succeeded");
  });
  it("after a lost POST response closes the one-use confirmation and reads operation status before retry", async () => {
    mocks.fetchJson.mockResolvedValueOnce({ confirmation: { action: "restart", token: "fixture-token", expiresAt: Date.now() + 10000, impact: [], currentVersion: "2026.09.06" } }).mockRejectedValueOnce(new Error("response lost"));
    await act(async () => root.render(<UpdateCenterSection />));
    await act(async () => button("updateCenter.restartNow").click());
    await act(async () => button("updateCenter.action.restart").click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("updateCenter.operationUnconfirmed", { type: "warning" });
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });
});
