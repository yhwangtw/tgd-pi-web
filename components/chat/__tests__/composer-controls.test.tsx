// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MODEL_PINNED_STORAGE_KEY, MODEL_RECENT_STORAGE_KEY } from "@/lib/model-selector-prefs";
import { ChatInput } from "../ChatInput";
import { ModelSelector } from "../ModelSelector";
import { ThinkingSelector } from "../ThinkingSelector";
import { ToolPresetSelector } from "../ToolPresetSelector";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeMatchMedia = window.matchMedia;

function useMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 700px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("composer controls", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    localStorage.removeItem("pi-stream-send-mode");
    localStorage.removeItem(MODEL_RECENT_STORAGE_KEY);
    localStorage.removeItem(MODEL_PINNED_STORAGE_KEY);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: nativeMatchMedia,
    });
    setLocale("en");
  });

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(node));
  }

  async function nextFrame() {
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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
    expect(container!.textContent).toContain("Read-only exploration and planning");
    expect(container!.textContent).toContain("All built-in tools");
  });

  it("opens the model menu on the selected option and supports arrow-key navigation", async () => {
    const options = [
      { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
      { provider: "openai", modelId: "gpt-5.5", name: "GPT-5.5" },
      { provider: "openai", modelId: "gpt-5.6", name: "GPT-5.6" },
    ];
    await render(
      <ModelSelector
        modelOptions={options}
        modelsByProvider={[{ provider: "openai", options }]}
        currentName="GPT-5.5"
        model={{ provider: "openai", modelId: "gpt-5.5" }}
        isStreaming={false}
        onModelChange={vi.fn()}
      />,
    );

    const trigger = container!.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await nextFrame();

    const listbox = container!.querySelector<HTMLElement>('[role="listbox"]')!;
    const optionsEls = [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);
    expect(optionsEls[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(optionsEls[1]);

    await act(async () => optionsEls[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await nextFrame();
    expect(document.activeElement).toBe(optionsEls[2]);

    await act(async () => optionsEls[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    await nextFrame();
    expect(document.activeElement).toBe(optionsEls[0]);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await nextFrame();
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects a model and restores focus to the trigger", async () => {
    const onModelChange = vi.fn();
    const options = [
      { provider: "openai", modelId: "gpt-5.5", name: "GPT-5.5" },
      { provider: "openai", modelId: "gpt-5.6", name: "GPT-5.6" },
    ];
    await render(
      <ModelSelector
        modelOptions={options}
        modelsByProvider={[{ provider: "openai", options }]}
        currentName="GPT-5.5"
        model={{ provider: "openai", modelId: "gpt-5.5" }}
        isStreaming={false}
        onModelChange={onModelChange}
      />,
    );

    const trigger = container!.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    await act(async () => trigger.click());
    await nextFrame();
    const nextModel = [...container!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("GPT-5.6"))!;
    await act(async () => nextModel.click());
    await nextFrame();

    expect(onModelChange).toHaveBeenCalledWith("openai", "gpt-5.6");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses a searchable mobile sheet with model metadata, pinning, and recent history", async () => {
    useMobileViewport();
    const onModelChange = vi.fn();
    const options = [
      {
        provider: "openai",
        modelId: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        available: true,
        contextWindow: 272_000,
        cost: { input: 0.25, output: 2 },
      },
      {
        provider: "zai",
        modelId: "glm-5.3",
        name: "GLM-5.3",
        available: true,
        contextWindow: 128_000,
        cost: { input: 1, output: 3 },
      },
    ];
    await render(
      <ModelSelector
        modelOptions={options}
        modelsByProvider={[
          { provider: "openai", options: [options[0]] },
          { provider: "zai", options: [options[1]] },
        ]}
        currentName="GPT-5.6 Luna"
        model={{ provider: "openai", modelId: "gpt-5.6-luna" }}
        isStreaming={false}
        onModelChange={onModelChange}
      />,
    );
    await nextFrame();

    const trigger = container!.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    await act(async () => trigger.click());
    await nextFrame();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Choose a model");
    expect(dialog.textContent).toContain("Available");
    expect(dialog.textContent).toContain("272k ctx");
    expect(dialog.textContent).toContain("$0.25 / $2 · 1M");
    const search = dialog.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    expect(document.activeElement).toBe(search);

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(search, "glm");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(dialog.textContent).not.toContain("GPT-5.6 Luna");
    expect(dialog.textContent).toContain("GLM-5.3");

    const glmSelect = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("GLM-5.3"))!;
    const glmRow = glmSelect.parentElement!;
    const pin = glmRow.querySelector<HTMLButtonElement>('button[aria-label="Pin model"]')!;
    await act(async () => pin.click());
    expect(dialog.querySelector('button[aria-label="Unpin model"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(MODEL_PINNED_STORAGE_KEY)).toContain("glm-5.3");

    const pinnedGlmSelect = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("GLM-5.3"))!;
    await act(async () => pinnedGlmSelect.click());
    await nextFrame();
    expect(onModelChange).toHaveBeenCalledWith("zai", "glm-5.3");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(localStorage.getItem(MODEL_RECENT_STORAGE_KEY)).toContain("glm-5.3");
  });

  it("exposes selector menus as listboxes and closes them with Escape", async () => {
    await render(
      <ThinkingSelector
        thinkingLevel="auto"
        isStreaming={false}
        onThinkingLevelChange={vi.fn()}
      />,
    );

    const trigger = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Change reasoning level"]',
    )!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container!.querySelectorAll('[role="option"]').length).toBeGreaterThan(1);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
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
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-label")).toBe("Composer controls");
    expect(panel.textContent).toContain("Composer");
    expect(panel.textContent).toContain("Reasoning");
    expect(panel.textContent).toContain("Tools");
    expect(panel.textContent).toContain("Response scroll");
    expect(panel.textContent).toContain("Smart follow");
    expect(panel.querySelector('[role="radiogroup"][aria-label="Change response scroll mode"]')).not.toBeNull();
    expect(panel.textContent).toContain("Done");

    const done = [...panel.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Done")!;
    await act(async () => done.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.className).not.toContain("bottomBarRightMobileOpen");
  });

  it("opens mobile composer controls as a focus-managed bottom sheet", async () => {
    useMobileViewport();
    const onThinkingLevelChange = vi.fn();
    const onToolPresetChange = vi.fn();
    await render(
      <ChatInput
        onSend={vi.fn()}
        onAbort={vi.fn()}
        isStreaming={false}
        onCompact={vi.fn()}
        thinkingLevel="medium"
        onThinkingLevelChange={onThinkingLevelChange}
        toolPreset="default"
        onToolPresetChange={onToolPresetChange}
      />,
    );
    await nextFrame();

    const trigger = container!.querySelector<HTMLButtonElement>('button[aria-label="More composer controls"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(document.body.querySelector('[data-testid="composer-controls-sheet"]')).toBeNull();

    await act(async () => trigger.click());
    await nextFrame();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const sheet = dialog.querySelector<HTMLElement>('[data-testid="composer-controls-sheet"]')!;
    expect(dialog.textContent).toContain("Composer controls");
    expect(sheet.textContent).toContain("Composer");
    expect(sheet.textContent).toContain("Reasoning");
    expect(sheet.textContent).toContain("Tools");
    expect(dialog.textContent).toContain("Done");
    expect(Boolean(container!.inert)).toBe(true);
    expect(document.activeElement).toBe(sheet.querySelector('button[aria-label="Expand composer"]'));

    const reasoning = sheet.querySelector<HTMLButtonElement>('button[aria-label="Change reasoning level"]')!;
    await act(async () => reasoning.click());
    const reasoningList = sheet.querySelector<HTMLElement>('[role="listbox"][aria-label="Change reasoning level"]')!;
    expect(reasoning.closest('[data-inline-selector-open="true"]')).not.toBeNull();
    expect(reasoning.getAttribute("aria-controls")).toBe(reasoningList.id);
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const high = [...reasoningList.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("High"))!;
    await act(async () => high.click());
    await nextFrame();
    expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
    expect(sheet.querySelector('[role="listbox"][aria-label="Change reasoning level"]')).toBeNull();
    expect(document.activeElement).toBe(reasoning);

    const tools = sheet.querySelector<HTMLButtonElement>('button[aria-label="Change tool preset"]')!;
    await act(async () => tools.click());
    const toolList = sheet.querySelector<HTMLElement>('[role="listbox"][aria-label="Change tool preset"]')!;
    expect(tools.closest('[data-inline-selector-open="true"]')).not.toBeNull();
    expect(sheet.querySelector('[role="listbox"][aria-label="Change reasoning level"]')).toBeNull();
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const full = [...toolList.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("All built-in tools"))!;
    await act(async () => full.click());
    await nextFrame();
    expect(onToolPresetChange).toHaveBeenCalledWith("full");
    expect(sheet.querySelector('[role="listbox"][aria-label="Change tool preset"]')).toBeNull();
    expect(document.activeElement).toBe(tools);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await nextFrame();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(Boolean(container!.inert)).toBe(false);
  });

  it("uses a short streaming placeholder for the selected delivery mode", async () => {
    await render(
      <ChatInput
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onSteer={vi.fn()}
        onFollowUp={vi.fn()}
        isStreaming
      />,
    );

    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.placeholder).toBe("Queue a follow-up…");

    const steer = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Steer")!;
    await act(async () => steer.click());
    expect(textarea.placeholder).toBe("Steer the current run…");
  });

  it("marks the disabled model control separately from active streaming actions", async () => {
    await render(
      <ChatInput
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onSteer={vi.fn()}
        onFollowUp={vi.fn()}
        isStreaming
        model={{ provider: "openai", modelId: "gpt-test" }}
        modelNames={{ "openai:gpt-test": "GPT Test" }}
        modelList={[{ provider: "openai", id: "gpt-test", name: "GPT Test" }]}
        onModelChange={vi.fn()}
      />,
    );

    const modelButton = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "GPT Test")!;
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.parentElement?.className).toContain("modelControl");
    expect(container!.querySelector('[role="group"][aria-label="Message delivery mode"]')).not.toBeNull();
  });
});
