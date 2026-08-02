// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ChatInput } from "../ChatInput";
import { ThinkingSelector } from "../ThinkingSelector";
import { ToolPresetSelector } from "../ToolPresetSelector";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("composer controls", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    setLocale("en");
  });

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(node));
  }

  it("renders the thinking-level selector in Traditional Chinese without simplified Chinese", async () => {
    setLocale("zh");
    await render(
      <ThinkingSelector
        thinkingLevel="auto"
        isStreaming={false}
        onThinkingLevelChange={vi.fn()}
      />,
    );

    const trigger = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="切換推理層級"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());

    expect(container!.textContent).toContain("沿用 Pi 預設值");
    expect(container!.textContent).toContain("低強度推理");
    expect(container!.textContent).toContain("最高強度推理");
    expect(`${container!.textContent} ${container!.innerHTML}`).not.toMatch(/切换|默认|关闭|强度|设置/);
  });

  it("localizes thinking levels and tool presets in English", async () => {
    setLocale("en");
    await render(
      <>
        <ThinkingSelector
          thinkingLevel="medium"
          isStreaming={false}
          onThinkingLevelChange={vi.fn()}
        />
        <ToolPresetSelector
          toolPreset="default"
          isStreaming={false}
          onToolPresetChange={vi.fn()}
        />
      </>,
    );

    const thinking = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Change reasoning level"]',
    );
    const tools = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Change tool preset"]',
    );
    expect(thinking?.textContent).toContain("Medium");
    expect(tools?.textContent).toContain("Default");

    await act(async () => tools!.click());
    expect(container!.textContent).toContain("No tools, chat only");
    expect(container!.textContent).toContain("All built-in tools");
  });

  it("keeps the textarea full-width and the primary send action inside the composer card", async () => {
    setLocale("zh");
    await render(
      <ChatInput
        onSend={vi.fn()}
        onAbort={vi.fn()}
        isStreaming={false}
      />,
    );

    const shell = container!.querySelector<HTMLElement>('[data-testid="composer-shell"]');
    const inputRow = container!.querySelector<HTMLElement>('[data-testid="composer-input-row"]');
    const toolbar = container!.querySelector<HTMLElement>('[data-testid="composer-toolbar"]');
    const textarea = container!.querySelector("textarea");
    const send = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("傳送"));

    expect(shell).not.toBeNull();
    expect(inputRow?.contains(textarea)).toBe(true);
    expect(toolbar?.contains(send ?? null)).toBe(true);
    expect(toolbar?.textContent).toContain("Enter 傳送 · Shift+Enter 換行");
  });

  it("keeps secondary controls behind one disclosure button", async () => {
    await render(
      <ChatInput
        onSend={vi.fn()}
        onAbort={vi.fn()}
        isStreaming={false}
        onCompact={vi.fn()}
      />,
    );

    const trigger = container!.querySelector<HTMLButtonElement>('button[aria-label="More composer controls"]')!;
    const panel = container!.querySelector<HTMLElement>("#composer-secondary-tools")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.className).not.toContain("bottomBarRightMobileOpen");

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.className).toContain("bottomBarRightMobileOpen");
    expect(panel.textContent).toContain("Composer");
    expect(panel.textContent).toContain("Reasoning");
    expect(panel.textContent).toContain("Tools");
  });
});
