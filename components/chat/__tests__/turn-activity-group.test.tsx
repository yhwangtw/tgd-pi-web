// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.useRealTimers();
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

  it("shows an active tool summary while details are closed and retires it on completion", async () => {
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root?.render(<TurnActivityGroup steps={2} tools={1} filesChanged={0} failed={0} state="running" activeSummary="read · src/a.ts"><div>Raw tool details</div></TurnActivityGroup>));
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="active-work-summary"]')?.textContent).toBe("read · src/a.ts");
    expect(host.textContent).not.toContain("Raw tool details");
    await act(async () => root?.render(<TurnActivityGroup steps={2} tools={1} filesChanged={0} failed={0} state="success" activeSummary="read · src/a.ts"><div>Raw tool details</div></TurnActivityGroup>));
    expect(host.querySelector('[data-testid="active-work-summary"]')).toBeNull();
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
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
  it("ticks only the active total from the same run start and opens once per explicit request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    const view = (request?: number, state: "running" | "success" = "running") => <TurnActivityGroup steps={2} tools={1} filesChanged={0} failed={0} state={state} elapsed={1} startedAt={55_000} revealRequest={request}><div>Current tool</div></TurnActivityGroup>;
    await act(async () => root!.render(view()));
    expect(host.querySelector('[data-testid="work-log-elapsed"]')?.textContent).toBe("Total 45s");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.querySelector('[data-testid="work-log-elapsed"]')?.textContent).toBe("Total 47s");
    await act(async () => root!.render(view(1)));
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => host!.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => root!.render(view(1)));
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => root!.render(view(2)));
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => root!.render(view(2, "success")));
    expect(host.querySelector('[data-testid="work-log-elapsed"]')).toBeNull();
  });

});
