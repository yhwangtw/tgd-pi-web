// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpCenter } from "../McpCenter";
import type { McpServerConfig, McpServerStatus } from "@/lib/mcp";

const state = vi.hoisted(() => ({ data: { servers: [] as McpServerConfig[], statuses: [] as McpServerStatus[] }, refresh: vi.fn(async () => {}) }));
vi.mock("@/hooks/useRequestResource", () => ({ fetchJson: vi.fn(), useRequestResource: () => ({ data: state.data, refresh: state.refresh }) }));
vi.mock("@/hooks/useToast", () => ({ showToast: vi.fn() }));
vi.mock("@/components/ui/DialogShell", () => ({ DialogShell: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer: ReactNode }) =>
  open ? <section role="dialog" aria-label={title}>{children}{footer}</section> : null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.data = { servers: [{ id: "remote", name: "Fixture", enabled: true, transport: "http", scope: "global",
    url: "https://example.test/mcp", timeoutMs: 1250, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" }], statuses: [] };
  fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => { callback(0); return 0; });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<McpCenter cwd={null} sessionId={null} />)); }
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
async function setTimeoutValue(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("MCP timeout and connection status UI", () => {
  it.each([["1", 1000], ["1.25", 1250], ["120", 120000]])("displays seconds and saves %s as %i milliseconds", async (seconds, expected) => {
    await render(); await click("Edit");
    expect(container.textContent).toContain("Timeout (seconds)");
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("1.25");
    await setTimeoutValue(seconds); await click("Save server");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.server.timeoutMs).toBe(expected);
    expect(body.server).not.toHaveProperty("timeoutSeconds");
  });
  it.each(["", "0.5", "121", "0.9999", "120.0004", "1.2345"])("keeps invalid %s seconds in the editor without sending a request", async (value) => {
    await render(); await click("Edit");
    const input = await setTimeoutValue(value); await click("Save server");
    expect(fetcher).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(container.textContent).toContain("between 1 and 120 seconds");
  });
  it("does not fabricate Connecting without evidence or render catalog changes as errors", async () => {
    await render();
    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).not.toContain("Connecting");
    state.data.statuses = [{ id: "remote", state: "disconnected", tools: [], toolCount: 0 }];
    await render(); expect(container.textContent).toContain("Disconnected");
    state.data.statuses = [{ id: "remote", state: "connected", catalogChanged: true, checkedAt: "2026-09-06T00:00:00Z", tools: [], toolCount: 0 }];
    await render(); expect(container.textContent).toContain("Reload Extensions after the current run");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-state="error"]')).toBeNull();
    expect(container.textContent).toContain("not continuous monitoring");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-06T00:00:00Z");
  });
});
