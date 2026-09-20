// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionItem } from "../SessionItem";
import type { SessionInfo } from "@/lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const session: SessionInfo = { id: "one", path: "/tmp/one.jsonl", cwd: "/work/project", name: "Hi", firstMessage: "Hi", lastMessage: "Changes are ready", messageCount: 4, created: "2026-09-01T00:00:00Z", modified: "2026-09-12T00:00:00Z" };
let root: Root; let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); vi.restoreAllMocks(); });
async function render(showProject: boolean) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const onClick = vi.fn(); const onPinToggle = vi.fn();
  await act(async () => root.render(<SessionItem session={session} isSelected showProject={showProject} displayTitle="Hi · project · 2026-09-12" onClick={onClick} onPinToggle={onPinToggle} />));
  return { onClick, onPinToggle };
}

describe("quiet conversation row", () => {
  it.each([true, false])("shows project only in cross-project mode: %s", async showProject => {
    await render(showProject);
    const title = container.querySelector<HTMLElement>('[class*="sessionTitle"]')!;
    expect(title.textContent).toBe("Hi");
    expect(title.title).toContain("Hi · project · 2026-09-12");
    expect(title.title).toContain("/work/project");
    expect(container.querySelector('[class*="workspaceMeta"]')?.textContent ?? null).toBe(showProject ? "project" : null);
    expect(container.querySelector('[class*="previewRow"]')?.textContent).toContain("Changes are ready");
    expect(container.querySelector('[role="option"]')?.getAttribute("aria-label")).toBe("Hi · project · 2026-09-12");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
  it("retains pin and rename in a keyboard accessible, portalled menu", async () => {
    const { onClick, onPinToggle } = await render(true);
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await act(async () => trigger.click());
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.parentElement).toBe(document.body);
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => items[0].click());
    expect(onPinToggle).toHaveBeenCalledExactlyOnceWith("one");
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    const rename = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === "Rename")!;
    await act(async () => rename.click());
    expect(container.querySelector("input")).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
