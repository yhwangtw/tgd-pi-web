// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
    const status = container!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.dataset.progressState).toBe("delayed");
    expect(status.dataset.tone).toBe("neutral");
    expect(status.textContent).toContain("模型仍在處理");
    expect(status.textContent).not.toContain("停滯");
  });

  it("keeps a long wait calm instead of declaring failure", async () => {
    await render({ idleSeconds: 180, attention: "stalled", connection: "connected" });
    const status = container!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.dataset.progressState).toBe("stalled");
    expect(status.dataset.tone).toBe("neutral");
    expect(status.textContent).toContain("Taking longer than usual");
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
    expect(container!.textContent).toContain("tool is still running");
  });

  it("reserves warning tone for actual reconnects", async () => {
    await render({ idleSeconds: 20, attention: "normal", connection: "reconnecting" });
    const status = container!.querySelector<HTMLElement>('[role="status"]')!;
    expect(runStatusState({ idleSeconds: 20, attention: "normal", connection: "reconnecting" })).toBe("reconnecting");
    expect(status.dataset.tone).toBe("warning");
    expect(status.textContent).toContain("reconnecting");
  });

  it("announces only the semantic label, not the ticking timer", async () => {
    await render({ idleSeconds: 0, attention: "normal", connection: "connected" });
    const status = container!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
