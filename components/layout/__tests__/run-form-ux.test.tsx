// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRequestState } from "@/lib/request-state";
import { setLocale } from "@/lib/i18n";
import { AgentRunForm } from "../AgentRunForm";
import { SchedulePanel } from "../SchedulePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pending = new Map<string, (response: Response) => void>();
let host: HTMLDivElement;
let root: Root;
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(360); }); }
async function fill(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    if (input instanceof HTMLSelectElement) { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); }
    else { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
}
async function resolve(cwd: string, id: string) {
  await act(async () => pending.get(cwd)!(json({ modelList: [{ provider: "fixture", id, name: id }] })));
}
function modelField() { return [...document.querySelectorAll("label")].find(label => label.textContent?.startsWith("Model"))!.querySelector("select")!; }
function cwdField() { return document.querySelector<HTMLInputElement>('input[list]')!; }

beforeEach(() => {
  setLocale("en"); resetRequestState(); vi.useFakeTimers(); pending.clear();
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/models") return new Promise<Response>(done => pending.set(JSON.parse(String(init?.body)).cwd, done));
    if (url === "/api/projects/discover") return Promise.resolve(json({ repos: [{ path: "/fixture/b", name: "Other project" }] }));
    return Promise.resolve(json({ schedules: [], runs: [], serverTime: "" }));
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetRequestState(); vi.useRealTimers(); vi.unstubAllGlobals(); });

for (const mode of ["agent", "schedule"] as const) describe(`${mode} project models`, () => {
  it("offers project suggestions and ignores a late catalog from the previous cwd", async () => {
    await act(async () => root.render(mode === "agent"
      ? <AgentRunForm defaultCwd="/fixture/a" onCancel={vi.fn()} onCreated={vi.fn()} />
      : <SchedulePanel defaultCwd="/fixture/a" onOpenSession={vi.fn()} />));
    if (mode === "schedule") {
      const create = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "New schedule")!;
      await act(async () => create.click());
    }
    expect([...document.querySelectorAll("datalist option")].map(option => option.getAttribute("value"))).toContain("/fixture/b");
    await tick();
    expect(pending.has("/fixture/a")).toBe(true);
    await fill(cwdField(), "/fixture/b");
    expect(modelField().disabled).toBe(false);
    await tick(); await resolve("/fixture/b", "Model B");
    const choice = [...modelField().options].find(option => option.textContent?.includes("Model B"))!;
    await fill(modelField(), choice.value);
    await resolve("/fixture/a", "Late model A");
    expect(modelField().value).toBe(choice.value);
    expect(modelField().textContent).toContain("Model B");
    expect(modelField().textContent).not.toContain("Late model A");
    await fill(cwdField(), "/fixture/c");
    expect(modelField().value).toBe("");
    expect(modelField().textContent).not.toContain("Model B");
  });
});
