// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionUIPanel } from "../ExtensionUIPanel";
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

    const production = container!.querySelector<HTMLButtonElement>('[data-value="Production"]')!;
    await act(async () => production.click());
    const submit = container!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());

    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "select-1",
      value: "Production",
    });
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

    expect(container!.textContent).toContain("Waiting for approval");
    expect(container!.textContent).toContain("2 checks remaining");
    expect(container!.textContent).toContain("Question 1 / 2");
    expect(container!.querySelector<HTMLInputElement>('[data-question-id="note"]')).toBeNull();
    await act(async () => container!.querySelector<HTMLButtonElement>(
      '[data-question-id="target"][data-value="Production"]',
    )!.click());
    const next = container!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(next.textContent).toBe("Next");
    await act(async () => next.click());

    expect(container!.textContent).toContain("Question 2 / 2");
    const note = container!.querySelector<HTMLInputElement>('[data-question-id="note"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(note, "Roll out after smoke tests");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "ask-1",
      answers: { target: "Production", note: "Roll out after smoke tests" },
    });
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

    await act(async () => container!.querySelector<HTMLButtonElement>('[data-value="Production"]')!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    const back = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Back")!;
    await act(async () => back.click());

    expect(container!.textContent).toContain("Question 1 / 2");
    expect(container!.querySelector<HTMLButtonElement>('[data-value="Production"]')!.getAttribute("aria-pressed")).toBe("true");
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

    const other = container!.querySelector<HTMLButtonElement>('[data-value="__other__"]')!;
    expect(other.parentElement?.querySelector('[data-value="Default"]')).not.toBeNull();
    await act(async () => other.click());

    const path = container!.querySelector<HTMLInputElement>('input[data-question-id="path"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(path, "/tmp/project-tGD");
      path.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

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
