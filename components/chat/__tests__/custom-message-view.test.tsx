// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CustomMessageView } from "../CustomMessageView";

describe("CustomMessageView", () => {
  let root: Root | null = null;
  afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
  it("renders a safe generic fallback for extension custom messages", async () => {
    const node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
    await act(async () => root?.render(<CustomMessageView message={{ role: "custom", customType: "checkpoint", display: true, content: "**Ready**", details: { step: 2 } }} />));
    expect(node.textContent).toContain("checkpoint");
    expect(node.textContent).toContain("Ready");
    expect(node.querySelector("script")).toBeNull();
  });
});
