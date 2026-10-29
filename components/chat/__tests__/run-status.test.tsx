// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { RunStatus, runStatusState } from "../RunStatus";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RunStatus", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    setLocale("en");
    vi.useRealTimers();
  });

  async function render(progress: Parameters<typeof RunStatus>[0]["progress"], locale: "en" | "zh" = "en") {
    setLocale(locale);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <RunStatus phase={{ kind: "waiting_model" }} progress={progress} startedAt={null} />,
    ));
  }

  it("renders delayed model work as neutral information", async () => {
    await render({ idleSeconds: 90, attention: "delayed", connection: "connected" }, "zh");
    const status = container!.querySelector<HTMLElement>('[data-testid="run-monitor"]')!;
    expect(status.dataset.progressState).toBe("delayed");
    expect(status.dataset.tone).toBe("neutral");
    expect(status.textContent).toContain("等待模型回應");
    expect(status.textContent).toContain("暫無新進度");
    expect(status.textContent).toContain("1m 30s");
    expect(status.textContent).not.toContain("模型仍在處理");
    expect(status.textContent).not.toContain("停滯");
  });

  it("keeps a long wait calm instead of declaring failure", async () => {
    await render({ idleSeconds: 180, attention: "stalled", connection: "connected" });
    const status = container!.querySelector<HTMLElement>('[data-testid="run-monitor"]')!;
    expect(status.dataset.progressState).toBe("stalled");
    expect(status.dataset.tone).toBe("neutral");
    expect(status.textContent).toContain("awaiting new progress");
    expect(status.textContent).toContain("3m 0s");
    expect(status.textContent).not.toContain("No response");
  });

  it("uses the longer-running tool copy for delayed tools", async () => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <RunStatus
        phase={{ kind: "running_tools", tools: [{ id: "1", name: "bash" }] }}
        progress={{ idleSeconds: 180, attention: "delayed", connection: "connected" }}
        startedAt={null}
      />,
    ));
    expect(container!.textContent).toContain("Running bash");
    expect(container!.textContent).toContain("awaiting new progress");
    expect(container!.textContent).not.toContain("tool is still running");
  });

  it("reserves warning tone for actual reconnects", async () => {
    await render({ idleSeconds: 20, attention: "normal", connection: "reconnecting" });
    const status = container!.querySelector<HTMLElement>('[data-testid="run-monitor"]')!;
    expect(runStatusState({ idleSeconds: 20, attention: "normal", connection: "reconnecting" })).toBe("reconnecting");
    expect(status.dataset.tone).toBe("warning");
    expect(status.textContent).toContain("reconnecting");
  });

  it("shows accumulated elapsed time immediately after reconnect instead of resetting to zero", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    await render({ idleSeconds: 0, attention: "normal", connection: "connected" });
    await act(async () => root!.render(<RunStatus phase={{ kind: "writing" }} progress={{ idleSeconds: 0, attention: "normal", connection: "connected" }} startedAt={Date.now() - 65_000} />));
    expect(container!.textContent).toContain("Writing");
    expect(container!.textContent).toContain("1m 5s");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container!.textContent).toContain("1m 6s");
  });

  it("updates last progress from live events without requiring a transcript render", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const ref = { current: Date.now() - 12_000 };
    await render({ idleSeconds: 12, attention: "normal", connection: "connected" });
    await act(async () => root!.render(<RunStatus phase={{ kind: "thinking" }} progress={{ idleSeconds: 12, attention: "normal", connection: "connected" }} startedAt={Date.now() - 45_000} lastProgressAtRef={ref} />));
    expect(container!.querySelector('[data-testid="run-last-progress"]')!.textContent).toContain("12s ago");
    ref.current = Date.now();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container!.querySelector('[data-testid="run-last-progress"]')!.textContent).toContain("1s ago");
    expect(container!.querySelector('[data-testid="run-status-elapsed"]')!.textContent).toContain("46s");
    expect(container!.querySelector('[data-testid="run-monitor"]')!.getAttribute("data-progress-state")).toBe("normal");
  });

  it("keeps the active tool target visible independently of details", async () => {
    await render({ idleSeconds: 10, attention: "normal", connection: "connected" });
    await act(async () => root!.render(<RunStatus phase={{ kind: "running_tools", tools: [{ id: "call1", name: "read" }] }} progress={{ idleSeconds: 10, attention: "normal", connection: "connected" }} startedAt={null} tools={[{ id: "call1", name: "read", preview: "src/ChatWindow.tsx", target: "src/ChatWindow.tsx", canReveal: true }]} />));
    expect(container!.querySelector('[data-testid="run-tool-preview"]')!.textContent).toBe("src/ChatWindow.tsx");
    expect(container!.textContent).toContain("Running read");
    expect(container!.querySelector('[data-testid="run-status-elapsed"]')).toBeNull();
  });

  it("announces only the semantic label, not the ticking timer", async () => {
    await render({ idleSeconds: 0, attention: "normal", connection: "connected" });
    const status = container!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).not.toContain("Last update");
    expect(status.textContent).not.toContain("Total");
    expect(container!.querySelector('[aria-live="off"]')).not.toBeNull();
  });
  it("opens full targets and individual subagent states by keyboard, then reveals the selected call", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const reveal = vi.fn();
    await render({ idleSeconds: 0, attention: "normal", connection: "connected" });
    const tools = [
      { id: "a", name: "read", preview: "src/a.ts", target: "src/a.ts", canReveal: true, startedAt: Date.now() - 10_000 },
      { id: "b", name: "subagent", preview: "2 tasks", target: "2 tasks", canReveal: true, children: [
        { id: "0", label: "scout", state: "completed" as const }, { id: "1", label: "reviewer", state: "running" as const },
      ] },
    ];
    await act(async () => root!.render(<RunStatus phase={{ kind: "running_tools", tools }} progress={{ idleSeconds: 0, attention: "normal", connection: "connected" }} startedAt={Date.now() - 45_000} tools={tools} onRevealTool={reveal} />));
    const toggle = container!.querySelector<HTMLButtonElement>('[aria-controls]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(container!.querySelectorAll('[data-testid="run-tool-row"]')).toHaveLength(2);
    expect(container!.textContent).toContain("This step 10s");
    expect(container!.querySelector('[data-child-state="completed"]')?.textContent).toContain("scout");
    expect(container!.querySelector('[data-child-state="running"]')?.textContent).toContain("reviewer");
    const second = container!.querySelector<HTMLButtonElement>('[data-active-tool="b"] button')!;
    await act(async () => second.click());
    expect(reveal).toHaveBeenCalledExactlyOnceWith("b");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    await act(async () => container!.querySelector('[data-testid="run-monitor"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("prioritizes retry countdown over stale writing, then explicit stop over retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    await render({ idleSeconds: 0, attention: "normal", connection: "connected" });
    const props = { progress: { idleSeconds: 0, attention: "normal" as const, connection: "connected" as const }, startedAt: 90_000, retry: { attempt: 2, maxAttempts: 3, retryAt: 102_000 } };
    await act(async () => root!.render(<RunStatus {...props} phase={{ kind: "writing" }} />));
    expect(container!.textContent).toContain("Retry 2/3 in 2s"); expect(container!.textContent).not.toContain("Writing");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container!.textContent).toContain("Retrying 2/3 · Writing");
    expect(container!.textContent).not.toContain("waiting for response");
    await act(async () => root!.render(<RunStatus {...props} phase={{ kind: "writing" }} progress={{ ...props.progress, connection: "reconnecting" }} />));
    expect(container!.textContent).toContain("Last state: Retrying 2/3 · Writing");
    await act(async () => root!.render(<RunStatus {...props} phase={{ kind: "stopping" }} />));
    expect(container!.querySelector('[data-run-operation="stopping"]')).not.toBeNull();
    expect(container!.textContent).toContain("Stopping"); expect(container!.textContent).not.toContain("Retrying");
  });

  it("describes quiet thinking as the last observed state", async () => {
    await render({ idleSeconds: 200, attention: "stalled", connection: "connected" });
    await act(async () => root!.render(<RunStatus phase={{ kind: "thinking" }} progress={{ idleSeconds: 200, attention: "stalled", connection: "connected" }} startedAt={null} />));
    expect(container!.textContent).toContain("Last state: Thinking");
    expect(container!.querySelector('[data-testid="run-monitor"]')!.getAttribute("data-tone")).toBe("neutral");
  });

  it("removes the live monitor when the run has ended", async () => {
    await render({ idleSeconds: 0, attention: "normal", connection: "connected" });
    expect(container!.querySelector('[data-testid="streaming-speed"]')).toBeNull();
    await act(async () => root!.render(<RunStatus phase={null} progress={{ idleSeconds: 0, attention: "normal", connection: "connected" }} startedAt={null} active={false} />));
    expect(container!.querySelector('[data-testid="run-monitor"]')).toBeNull();
    expect(container!.querySelector('[data-testid="completed-speed"]')).toBeNull();
  });

});
