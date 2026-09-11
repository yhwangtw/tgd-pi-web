// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionUIPanel, PendingQuestionNotice } from "../ExtensionUIPanel";
import type { ExtensionUIState } from "@/hooks/use-extension-ui";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExtensionUIPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  async function render(state: ExtensionUIState, onRespond = vi.fn().mockResolvedValue(undefined)) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<ExtensionUIPanel state={state} onRespond={onRespond} />));
    return { onRespond };
  }

  it("keeps the question shortcut stable until pointer activation and supports keyboard clicks", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onShow = vi.fn();
    await act(async () => root?.render(<PendingQuestionNotice onShow={onShow} />));
    const button = container.querySelector("button")!;
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(down, "isPrimary", { value: true });
    await act(async () => button.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(onShow).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(onShow).toHaveBeenCalledOnce();
    // Keyboard activation dispatches click without pointerdown.
    await act(async () => button.click());
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it("submits a selected extension option", async () => {
    const state: ExtensionUIState = {
      dialogs: [{
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Deploy target",
        options: ["Staging", "Production"],
      }],
      statuses: {},
      widgets: {},
    };
    const { onRespond } = await render(state);

    const production = document.body.querySelector<HTMLButtonElement>('[data-value="Production"]')!;
    await act(async () => production.click());
    const submit = document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());

    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "select-1",
      value: "Production",
    });
  });

  it("suppresses rapid double-submit and preserves a failed answer for retry", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const onRespond = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue(undefined);
    await render({
      dialogs: [{ type: "extension_ui_request", id: "retry-1", method: "select", title: "Pick", options: ["A", "B"] }],
      statuses: {}, widgets: {},
    }, onRespond);
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-value="B"]')!.click());
    const form = document.body.querySelector<HTMLFormElement>("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onRespond).toHaveBeenCalledOnce();
    await act(async () => rejectFirst(new Error("Response transport lost")));
    expect(document.body.textContent).toContain("Response transport lost");
    expect(document.body.querySelector<HTMLButtonElement>('[data-value="B"]')!.getAttribute("aria-checked")).toBe("true");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond.mock.calls[1][0]).toEqual(onRespond.mock.calls[0][0]);
  });

  it("isolates the background, traps focus, cancels with Escape, and restores focus", async () => {
    const launcher = document.createElement("button");
    launcher.textContent = "Open question";
    document.body.appendChild(launcher);
    launcher.focus();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const state: ExtensionUIState = {
      dialogs: [{
        type: "extension_ui_request",
        id: "confirm-modal",
        method: "confirm",
        title: "Confirm release",
        message: "Continue?",
      }],
      statuses: {},
      widgets: {},
    };
    await render(state, onRespond);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container!.inert).toBe(true);
    expect(launcher.inert).toBe(true);

    const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = controls[0];
    const last = controls.at(-1)!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(first);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "confirm-modal",
      cancelled: true,
    });

    await act(async () => root?.render(<ExtensionUIPanel state={{ dialogs: [], statuses: {}, widgets: {} }} onRespond={onRespond} />));
    expect(Boolean(container!.inert)).toBe(false);
    expect(Boolean(launcher.inert)).toBe(false);
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it("collects structured ask_user answers and renders extension chrome", async () => {
    const state: ExtensionUIState = {
      dialogs: [{
        type: "extension_ui_request",
        id: "ask-1",
        method: "ask_user",
        questions: [
          {
            id: "target",
            header: "Deploy",
            question: "Where should this release go?",
            options: [
              { label: "Staging", description: "Validate safely" },
              { label: "Production", description: "Release to users" },
            ],
            allowOther: false,
          },
          {
            id: "note",
            header: "Context",
            question: "Any release note?",
            options: [],
            allowOther: true,
          },
        ],
      }],
      statuses: { review: "Waiting for approval" },
      widgets: { checks: { lines: ["2 checks remaining"], placement: "aboveEditor" } },
    };
    const { onRespond } = await render(state);

    expect(document.body.textContent).toContain("Waiting for approval");
    expect(document.body.textContent).toContain("2 checks remaining");
    expect(document.body.textContent).toContain("1 / 2");
    expect(document.body.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"))
      .toBe("Where should this release go?");
    expect(document.body.querySelector<HTMLInputElement>('[data-question-id="note"]')).toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-question-id="target"][data-value="Production"]',
    )!.click());
    const next = document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(next.textContent).toBe("Next");
    await act(async () => next.click());

    expect(document.body.textContent).toContain("2 / 2");
    const note = document.body.querySelector<HTMLInputElement>('[data-question-id="note"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(note, "Roll out after smoke tests");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "ask-1",
      answers: { target: "Production", note: "Roll out after smoke tests" },
    });
  });

  it("keeps ask_user inline without taking focus or blocking outside controls, and preserves deferred answers", async () => {
    const outside = document.createElement("button");
    outside.textContent = "Inspect files";
    const inspect = vi.fn();
    outside.onclick = inspect;
    document.body.appendChild(outside);
    outside.focus();
    try {
      const state: ExtensionUIState = {
        dialogs: [{ type: "extension_ui_request", id: "inline-question", method: "ask_user", questions: [{ id: "target", question: "Where should it run?", options: [{ label: "Staging" }, { label: "Production" }], allowOther: false }] }],
        statuses: {}, widgets: {},
      };
      const { onRespond } = await render(state);
      expect(container!.querySelector('[data-testid="inline-user-question"]')).not.toBeNull();
      expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
      expect(Boolean(outside.inert)).toBe(false);
      expect(Boolean(container!.inert)).toBe(false);
      expect(document.activeElement).toBe(outside);
      expect(document.body.style.overflow).not.toBe("hidden");
      await act(async () => document.body.querySelector<HTMLButtonElement>('[data-value="Production"]')!.click());
      const toggle = container!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      expect(body.hidden).toBe(true);
      await act(async () => { outside.focus(); outside.click(); });
      expect(inspect).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(outside);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(onRespond).not.toHaveBeenCalled();
      await act(async () => toggle.click());
      expect(body.hidden).toBe(false);
      expect(container!.querySelector('[data-value="Production"]')?.getAttribute("aria-checked")).toBe("true");
      await act(async () => container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(onRespond).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "inline-question", answers: { target: "Production" } });
    } finally { outside.remove(); }
  });

  it("preserves earlier answers when moving back through ask_user questions", async () => {
    const state: ExtensionUIState = {
      dialogs: [{
        type: "extension_ui_request",
        id: "ask-back",
        method: "ask_user",
        questions: [
          {
            id: "target",
            question: "Where should this release go?",
            options: [{ label: "Staging" }, { label: "Production" }],
            allowOther: false,
          },
          {
            id: "timing",
            question: "When should it run?",
            options: [{ label: "Now" }, { label: "Later" }],
            allowOther: false,
          },
        ],
      }],
      statuses: {},
      widgets: {},
    };
    await render(state);

    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-value="Production"]')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    const back = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Back")!;
    await act(async () => back.click());

    expect(document.body.textContent).toContain("1 / 2");
    expect(document.body.querySelector<HTMLButtonElement>('[data-value="Production"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it("supports arrow-key selection inside an ask_user choice group", async () => {
    const state: ExtensionUIState = {
      dialogs: [{
        type: "extension_ui_request",
        id: "ask-keyboard",
        method: "ask_user",
        questions: [{
          id: "target",
          question: "Where should this release go?",
          options: [{ label: "Staging" }, { label: "Production" }],
          allowOther: false,
        }],
      }],
      statuses: {},
      widgets: {},
    };
    await render(state);

    const staging = document.body.querySelector<HTMLButtonElement>('[data-value="Staging"]')!;
    const production = document.body.querySelector<HTMLButtonElement>('[data-value="Production"]')!;
    await act(async () => {
      staging.focus();
      staging.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    expect(production.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(production);
  });

  it("keeps the custom answer inside the option grid and submits it", async () => {
    const state: ExtensionUIState = {
      dialogs: [{
        type: "extension_ui_request",
        id: "ask-other",
        method: "ask_user",
        questions: [{
          id: "path",
          header: "Path",
          question: "Which path should be used?",
          options: [{ label: "Default", description: "Use the suggested path" }],
          allowOther: true,
        }],
      }],
      statuses: {},
      widgets: {},
    };
    const { onRespond } = await render(state);

    const other = document.body.querySelector<HTMLButtonElement>('[data-value="__other__"]')!;
    expect(other.parentElement?.querySelector('[data-value="Default"]')).not.toBeNull();
    await act(async () => other.click());

    const path = document.body.querySelector<HTMLInputElement>('input[data-question-id="path"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(path, "/tmp/project-tGD");
      path.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "ask-other",
      answers: { path: "/tmp/project-tGD" },
    });
  });

  it("hides the ambient Telegram connected status below the conversation", async () => {
    const state: ExtensionUIState = {
      dialogs: [],
      statuses: { telegram: "telegram connected" },
      widgets: {},
    };

    await render(state);

    expect(container!.childElementCount).toBe(0);
    expect(container!.textContent).not.toContain("telegram");
  });

  it("removes ANSI fragments from extension statuses and widgets", async () => {
    const state: ExtensionUIState = {
      dialogs: [],
      statuses: { "[38;5;109mtelegram[39m": "[38;5;44mdisconnected[39m" },
      widgets: {
        health: { lines: ["\u001b[31mNeeds attention\u001b[0m"], placement: "aboveEditor" },
      },
    };

    await render(state);

    expect(container!.textContent).toContain("telegram");
    expect(container!.textContent).toContain("disconnected");
    expect(container!.textContent).toContain("Needs attention");
    expect(container!.textContent).not.toMatch(/\[(?:\d{1,3};)*\d{1,3}m/);
  });
});
