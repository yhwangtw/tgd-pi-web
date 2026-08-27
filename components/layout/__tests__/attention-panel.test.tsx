// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@/lib/attention-center";
import { setLocale } from "@/lib/i18n";
import { AttentionPanel } from "../AttentionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AttentionPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    setLocale("en");
  });

  async function renderPanel(items: AttentionItem[] = [], readIds = new Set<string>()) {
    const handlers = {
      onRefresh: vi.fn(),
      onMarkRead: vi.fn(),
      onMarkAllRead: vi.fn(),
      onOpenSession: vi.fn(),
      onOpenSource: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <AttentionPanel items={items} readIds={readIds} loading={false} error={null} {...handlers} />,
    ));
    return handlers;
  }

  it("uses a semantic heading and a separate labelled action toolbar", async () => {
    await renderPanel();
    expect(container!.querySelector("h2")?.textContent).toBe("Attention");
    expect(container!.querySelector('[role="group"][aria-label="Attention actions"]')).not.toBeNull();
    expect(container!.querySelector('button[aria-label="Refresh attention items"] svg')).not.toBeNull();
    expect(container!.textContent).toContain("Nothing needs attention");
  });

  it("keeps item text readable and exposes both item actions", async () => {
    const item: AttentionItem = {
      id: "attention-1",
      source: "session",
      severity: "warning",
      status: "waiting_for_input",
      title: "The agent needs a decision before it can continue",
      summary: "Choose one of the available options.",
      occurredAt: "2026-08-28T00:00:00.000Z",
      sessionId: "session-1",
      cwd: "/Users/elon/project",
    };
    const handlers = await renderPanel([item]);
    const buttons = [...container!.querySelectorAll<HTMLButtonElement>("button")];
    const openButton = buttons.find((button) => button.textContent?.includes("Open session"))!;
    const readButton = buttons.find((button) => button.textContent?.includes("Mark read"))!;

    await act(async () => openButton.click());
    expect(handlers.onMarkRead).toHaveBeenCalledWith("attention-1");
    expect(handlers.onOpenSession).toHaveBeenCalledWith("session-1");
    expect(readButton.querySelector("svg")).not.toBeNull();
  });
});
