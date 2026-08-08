// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { formatDesignContext } from "@/lib/design-context";
import type { UserMessage } from "@/lib/types";
import { UserMessageView } from "../UserMessageView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("UserMessageView design reference", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("collapses captured implementation data behind a compact summary", async () => {
    const content = formatDesignContext({
      selector: ".composer > button",
      tagName: "BUTTON",
      text: "Send",
      html: '<button class="send">Send</button>',
      rect: { x: 12, y: 9, width: 91, height: 33 },
      viewport: { width: 390, height: 844 },
      styles: { display: "flex" },
    });
    const message: UserMessage = { role: "user", content };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<UserMessageView message={message} />));

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    expect(details!.querySelector("summary")?.textContent).toContain("Design reference");
    expect(details!.querySelector("summary")?.textContent).toContain("390×844");
    expect(details!.querySelector("pre")?.textContent).toBe(content);
  });
});
