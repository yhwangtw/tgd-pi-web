// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TgdArtifactsPanel } from "../TgdArtifactsPanel";
import { ExtensionsConfig } from "@/components/modals/ExtensionsConfig";
import { SessionContextMenu } from "@/components/sidebar/SessionContextMenu";
import type { SessionInfo } from "@/lib/types";
import type { ExtensionsReport } from "@/lib/extensions-info";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useToast", () => ({ showToast: toast }));
vi.mock("@/components/modals/PackageCenter", () => ({ PackageCenter: () => <p>packages content</p> }));
vi.mock("@/components/modals/RuntimeCenter", () => ({ RuntimeCenter: () => <p>runtime content</p> }));
vi.mock("@/components/modals/McpCenter", () => ({ McpCenter: () => <p>mcp content</p> }));
vi.mock("@/components/modals/SecurityActivityCenter", () => ({ SecurityActivityCenter: () => <p>security content</p> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  localStorage.clear(); toast.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ exists: false }) })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function key(target: Element, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}

it.each(["tgd", "extensions"])("%s provides roving tabs, arrows/Home/End and an associated panel", async kind => {
  await act(async () => root.render(kind === "tgd"
    ? <TgdArtifactsPanel cwd="/fixture" onOpenFile={vi.fn()} />
    : <ExtensionsConfig sessionId={null} cwd="/fixture" onClose={vi.fn()} />));
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  expect(tabs.filter(tab => tab.tabIndex === 0)).toHaveLength(1);
  tabs[0].focus(); await key(tabs[0], "ArrowRight");
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1].tabIndex).toBe(0); expect(tabs[0].tabIndex).toBe(-1);
  expect(document.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(tabs[1].id);
  expect(tabs[1].getAttribute("aria-controls")).toBe(document.querySelector('[role="tabpanel"]')?.id);
  await key(tabs[1], "End"); expect(document.activeElement).toBe(tabs.at(-1));
  await key(tabs.at(-1)!, "ArrowRight"); expect(document.activeElement).toBe(tabs[0]);
  await key(tabs[0], "ArrowLeft"); expect(document.activeElement).toBe(tabs.at(-1));
  await key(tabs.at(-1)!, "Home"); expect(document.activeElement).toBe(tabs[0]);
  if (kind === "tgd") expect(localStorage.getItem("pi-tgd-artifacts-view")).toBe("artifacts");
});

it("represents tag containers as groups and includes tag removals/input in menu arrow navigation", async () => {
  const remove = vi.fn(); const close = vi.fn();
  const session: SessionInfo = { id: "fixture", path: "/fixture.jsonl", cwd: "/fixture", created: "", modified: "", messageCount: 0, firstMessage: "" };
  await act(async () => root.render(<SessionContextMenu position={{ x: 10, y: 10 }} session={session}
    isPinned={false} isParallelOpen={false} existingTags={["alpha", "beta"]} onClose={close}
    onPinToggle={vi.fn()} onOpenParallel={vi.fn()} onStartRename={vi.fn()} onAddTag={vi.fn()}
    onRemoveTag={remove} onRequestDelete={vi.fn()} />));
  const group = document.querySelector<HTMLElement>('[role="group"][aria-label="session.currentTags"]')!;
  expect(group.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  expect(group.closest('[role="menuitem"]')).toBeNull();
  const add = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.includes("session.addTag"))!;
  add.focus(); await key(add, "ArrowDown");
  expect(document.activeElement).toBe(group.querySelector("button"));
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(remove).toHaveBeenCalledExactlyOnceWith("alpha");
  expect(close).not.toHaveBeenCalled();
  await act(async () => add.click());
  const input = document.querySelector<HTMLInputElement>('input[data-menu-focus]')!;
  expect(document.activeElement).toBe(input);
  expect(input.closest("form")?.getAttribute("role")).toBe("group");
  expect(input.getAttribute("aria-label")).toBe("session.addTag");
  expect((await key(input, "Home")).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);
  await key(input, "ArrowDown"); expect(document.activeElement).toBe(group.querySelector("button"));
  await key(group.querySelector("button")!, "ArrowUp"); expect(document.activeElement).toBe(input);
  await key(input, "Escape"); expect(document.querySelector("input")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement?.textContent).toContain("session.addTag");
});

it("localizes extension flag/reload failure messages and reloads the report after a flag failure", async () => {
  const report: ExtensionsReport = {
    diagnostics: [], providers: [], commands: [], tools: [], flags: [{ name: "sample", type: "boolean", value: false }],
    shortcuts: [], events: [], renderers: [], resources: [], paths: [], permissions: [],
    compatibility: { providers: "supported", commands: "supported", tools: "supported", flags: "supported", commandContext: "partial", shortcuts: "partial", events: "partial", renderers: "partial", resources: "supported", tuiUi: "unsupported" },
  };
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => options?.method === "POST"
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => report });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<ExtensionsConfig sessionId="fixture" cwd="/fixture" onClose={vi.fn()} />));
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(toast).toHaveBeenCalledWith("extensions.flagUpdateFailed: HTTP 503", { type: "error" });
  const reload = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("extensions.reload"))!;
  await act(async () => reload.click());
  expect(toast).toHaveBeenCalledWith("extensions.reloadFailed: HTTP 503", { type: "error" });
  expect(fetcher.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2);
});
