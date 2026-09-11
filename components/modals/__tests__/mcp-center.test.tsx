// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpCenter } from "../McpCenter";
import type { McpServerConfig, McpServerStatus } from "@/lib/mcp";
import { showToast } from "@/hooks/useToast";

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
    revision: "fixture-revision", url: "https://example.test/mcp", timeoutMs: 1250, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" }], statuses: [] };
  state.refresh.mockReset();
  state.refresh.mockImplementation(async () => state.data as never);
  vi.mocked(showToast).mockClear();
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
  await setInputValue(input, value);
  return input;
}
async function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

describe("MCP draft conflict and save lifecycle", () => {
  const nameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="e.g. GitHub"]') ?? container.querySelector<HTMLInputElement>('fieldset input:not([type])')!;
  it.each([409, 428])("keeps the draft and original revision after HTTP %s until explicit reload", async status => {
    await render(); await click("Edit");
    await setInputValue(nameInput(), "My unsaved draft");
    fetcher.mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: "Changed in another tab" }) });
    state.data = { ...state.data, servers: [{ ...state.data.servers[0], name: "Other saved edit", revision: "new-revision" }] };
    await click("Save server");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Changed in another tab");
    expect(nameInput().value).toBe("My unsaved draft");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).server.revision).toBe("fixture-revision");
    await render();
    expect(nameInput().value).toBe("My unsaved draft");
    await click("Discard draft and reload");
    expect(nameInput().value).toBe("Other saved edit");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("Save server");
    expect(JSON.parse(fetcher.mock.calls[1][1].body).server.revision).toBe("new-revision");
  });
  it.each(["failed", "removed"])("keeps the draft if latest reload is %s", async outcome => {
    await render(); await click("Edit");
    await setInputValue(nameInput(), "Keep this text");
    fetcher.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "Changed" }) });
    await click("Save server");
    state.refresh.mockResolvedValueOnce(outcome === "failed" ? undefined : { servers: [], statuses: [] } as never);
    await click("Discard draft and reload");
    expect(nameInput().value).toBe("Keep this text");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(outcome === "failed" ? "Could not load" : "deleted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("focuses Name after a delayed conflict reload commits the enabled fieldset", async () => {
    await render(); await click("Edit");
    fetcher.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "Changed" }) });
    await click("Save server");
    const latest = { ...state.data, servers: [{ ...state.data.servers[0], name: "Saved in second tab", revision: "latest-revision" }] };
    let resolveReload!: (value: unknown) => void;
    state.refresh.mockReturnValueOnce(new Promise(done => { resolveReload = done; }) as never);
    const reload = [...container.querySelectorAll("button")].find(button => button.textContent === "Discard draft and reload")!;
    reload.focus();
    await click("Discard draft and reload");
    expect(nameInput().matches(":disabled")).toBe(true);
    // rAF is synchronous in this fixture: reproduce a frame arriving before
    // React commits the post-request update that removes fieldset.disabled.
    await act(async () => resolveReload(latest));
    expect(nameInput().value).toBe("Saved in second tab");
    expect(nameInput().matches(":disabled")).toBe(false);
    expect(document.activeElement).toBe(nameInput());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("preserves server errors inline and disables all editor controls while saving", async () => {
    let resolve!: (value: unknown) => void;
    fetcher.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await render(); await click("Edit"); await click("Save server");
    const editor = container.querySelector('fieldset')!;
    for (const control of editor.querySelectorAll("input,textarea,select")) expect(control.matches(":disabled")).toBe(true);
    await click("Save server");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: false, status: 500, json: async () => ({ error: "Storage unavailable" }) }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Storage unavailable");
    expect(nameInput().matches(":disabled")).toBe(false);
    expect(nameInput().value).toBe("Fixture");
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });
  it("sends the displayed revision for toggle and delete", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ action: "toggle", revision: "fixture-revision" });
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await click("Delete");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ action: "delete", revision: "fixture-revision" });
  });
  it("shows committed-save warnings and closes the successful draft", async () => {
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reloadWarning: "Saved, but reload failed" }) });
    await render(); await click("Edit"); await click("Save server");
    expect(container.querySelector("fieldset")).toBeNull();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith("Saved, but reload failed", expect.objectContaining({ type: "warning" }));
  });
  it("preserves untouched exact arguments instead of trimming or splitting them", async () => {
    state.data.servers[0] = { ...state.data.servers[0], enabled: false, transport: "stdio", command: "node", args: ["", "  padded  ", "line1\nline2"] };
    await render(); await click("Edit"); await setInputValue(nameInput(), "Renamed only"); await click("Save server");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).server.args).toEqual(["", "  padded  ", "line1\nline2"]);
  });
  it("preserves project identity when editing a saved project configuration from the global view", async () => {
    state.data.servers[0] = { ...state.data.servers[0], scope: "project", projectCwd: "/tmp/fixture-project" };
    await render(); await click("Edit"); await click("Save server");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).server.projectCwd).toBe("/tmp/fixture-project");
  });
});
