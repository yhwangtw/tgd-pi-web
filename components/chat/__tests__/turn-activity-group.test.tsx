// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { TurnActivityGroup } from "../TurnActivityGroup";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TurnActivityGroup", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => setLocale("en"));
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("keeps transcript position stable while opening a failed work log", async () => {
    host = document.createElement("div");
    host.dataset.transcriptScroll = "";
    host.scrollTop = 420;
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(
      <TurnActivityGroup steps={8} tools={4} filesChanged={0} failed={1} elapsed={11}>
        <div style={{ height: 900 }}>Long activity</div>
      </TurnActivityGroup>,
    ));

    const section = host.querySelector<HTMLElement>("section")!;
    const summary = host.querySelector<HTMLButtonElement>("button")!;
    expect(section.dataset.workLogExpanded).toBe("false");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).toContain("Needs attention");
    expect(summary.getAttribute("aria-label")).toContain("8 steps");

    await act(async () => {
      summary.click();
      if (typeof requestAnimationFrame === "function") {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    expect(section.dataset.workLogExpanded).toBe("true");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(host.scrollTop).toBe(420);
    expect(host.style.overflowAnchor).toBe("");
    expect(host.textContent).toContain("Long activity");
  });

  it("keeps successful work quiet and reserves outcome emphasis for attention", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(
      <TurnActivityGroup steps={2} tools={1} filesChanged={0} failed={0} elapsed={3}>
        <div>Successful activity</div>
      </TurnActivityGroup>,
    ));

    expect(host.textContent).toContain("Work log");
    expect(host.textContent).toContain("1 tool");
    expect(host.textContent).not.toContain("Completed");
    expect(host.querySelector("button")?.getAttribute("aria-label")).toContain("Completed");
  });
});
