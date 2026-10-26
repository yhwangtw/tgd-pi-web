// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ToolRunGroup, type ToolRunItem } from "../ToolRunGroup";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, toolName: string, duration?: number, failed = false): ToolRunItem => ({
  block: { type: "toolCall", toolCallId: id, toolName, input: {} },
  duration,
  result: duration !== undefined || failed ? { role: "toolResult", toolCallId: id, content: [], isError: failed } : undefined,
});

describe("ToolRunGroup", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => setLocale("en"));
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function render(items: ToolRunItem[], activeToolCallId?: string) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <ToolRunGroup items={items} executionContext={activeToolCallId ? { running: true, activeIds: new Set([activeToolCallId]) } : undefined}>
        <span>tool details</span>
      </ToolRunGroup>,
    ));
  }

  it("collapses completed calls into one elapsed-time summary", async () => {
    await render([item("1", "read", 5), item("2", "grep", 7), item("3", "find", 4)]);

    expect(container!.textContent).toContain("Ran 3 tools");
    expect(container!.textContent).toContain("7s");
    expect(container!.textContent).not.toContain("tool details");

    const summary = container!.querySelector<HTMLButtonElement>("button")!;
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    await act(async () => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container!.textContent).toContain("tool details");
  });

  it("highlights only the active tool and reports failures", async () => {
    await render([item("1", "read"), item("2", "grep", undefined, true)], "1");
    expect(container!.textContent).toContain("Running 2 tools");
    expect(container!.textContent).toContain("1 failed");
  });
});
