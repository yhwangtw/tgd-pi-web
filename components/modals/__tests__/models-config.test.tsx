// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsConfig } from "../ModelsConfig";

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../OAuthDetail", () => ({ OAuthDetail: () => null }));
vi.mock("../ApiKeyDetail", () => ({ ApiKeyDetail: () => null }));
vi.mock("../ProviderHealth", () => ({ ProviderHealth: () => <div>Health fixture</div> }));
vi.mock("../AddProviderPicker", () => ({ AddProviderPicker: () => <div>Picker fixture</div> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial = { providers: { alpha: { baseUrl: "https://alpha.test" }, beta: { baseUrl: "https://beta.test" } }, futureMetadata: { keep: true } };
let root: Root;
let container: HTMLDivElement;
let getCount = 0;
let failRead = false;
let conflict = false;
let conflictStatus = 409;
let unknownOutcome: "response" | "transport" | "invalid-ack" | "missing-success" | null = null;
const requests: Array<{ body: typeof initial; headers: Headers }> = [];
const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
  if (url === "/api/models-config" && options?.method === "PUT") {
    requests.push({ body: JSON.parse(options.body as string), headers: new Headers(options.headers) });
    if (unknownOutcome === "transport") throw new Error("private-fixture-key transport error");
    if (unknownOutcome === "invalid-ack") return new Response("private-fixture-key malformed ACK");
    if (unknownOutcome === "missing-success") return new Response(JSON.stringify({}));
    if (unknownOutcome === "response") return new Response(JSON.stringify({ error: "private-fixture-key hidden detail", code: "save_outcome_unknown" }), { status: 503 });
    return conflict ? new Response(JSON.stringify({ error: "Changed externally" }), { status: conflictStatus }) : new Response(JSON.stringify({ success: true }), { headers: { etag: '"revision-two"' } });
  }
  if (url === "/api/models-config") {
    getCount++;
    return failRead ? new Response(JSON.stringify({ error: "private-fixture-key must never render" }), { status: 503 }) : new Response(JSON.stringify(initial), { headers: { etag: '"revision-one"', "x-models-config-path": encodeURIComponent("/fixture/自訂/models.json") } });
  }
  return new Response(JSON.stringify({ providers: [] }));
});
beforeEach(() => {
  getCount = 0; failRead = false; conflict = false; conflictStatus = 409; unknownOutcome = null; requests.length = 0; fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
async function input(value: string) {
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Provider name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("models config draft safety", () => {
  it("shows the effective path and refuses a provider rename collision without losing either provider", async () => {
    await act(async () => root.render(<ModelsConfig onClose={() => {}} />));
    expect(document.body.textContent).toContain("/fixture/自訂/models.json");
    await act(async () => button("alpha").click());
    await input("beta");
    await act(async () => button("Rename").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("already exists");
    expect(button("alpha")).toBeTruthy(); expect(button("beta")).toBeTruthy();
    expect(requests).toHaveLength(0);
    expect(button("Save").disabled).toBe(true);
  });
  it.each([409, 428])("keeps the draft on %s and only discards it on explicit reload", async status => {
    conflict = true;
    conflictStatus = status;
    await act(async () => root.render(<ModelsConfig onClose={() => {}} />));
    await act(async () => button("alpha").click());
    await input("renamed");
    await act(async () => button("Rename").click());
    await act(async () => button("Save").click());
    expect(requests[0].headers.get("if-match")).toBe('"revision-one"');
    expect(requests[0].body.futureMetadata).toEqual({ keep: true });
    expect(requests[0].body.providers).toEqual({ renamed: initial.providers.alpha, beta: initial.providers.beta });
    expect(button("renamed")).toBeTruthy(); expect(getCount).toBe(1);
    const reload = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("discard draft"))!;
    await act(async () => reload.click());
    expect(getCount).toBe(2); expect(button("alpha")).toBeTruthy(); expect(button("renamed")).toBeUndefined();
  });
  it("fails closed on read errors, suppresses server details and disables save", async () => {
    failRead = true;
    await act(async () => root.render(<ModelsConfig onClose={() => {}} />));
    expect(document.body.textContent).not.toContain("private-fixture-key");
    expect(button("Save").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')).toBeTruthy();
    expect(requests).toHaveLength(0);
  });
  it.each(["response", "transport", "invalid-ack", "missing-success"] as const)("preserves the draft and requires explicit reload after an uncertain %s", async outcome => {
    unknownOutcome = outcome;
    await act(async () => root.render(<ModelsConfig onClose={() => {}} />));
    await act(async () => button("alpha").click());
    await input("renamed");
    await act(async () => button("Rename").click());
    await act(async () => button("Save").click());
    expect(requests).toHaveLength(1);
    expect(button("renamed")).toBeTruthy();
    expect(getCount).toBe(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("may have completed");
    expect(document.body.textContent).not.toContain("private-fixture-key");
    expect(button("Save").disabled).toBe(true);
    await act(async () => button("Save").click());
    expect(requests).toHaveLength(1);
    const reload = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("discard draft"))!;
    expect(reload).toBeTruthy();
    await act(async () => reload.click());
    expect(getCount).toBe(2);
    expect(button("alpha")).toBeTruthy();
    expect(button("renamed")).toBeUndefined();
  });
  it("keeps definite pre-commit failures retryable without claiming an uncertain commit", async () => {
    conflict = true;
    conflictStatus = 503;
    await act(async () => root.render(<ModelsConfig onClose={() => {}} />));
    await act(async () => button("alpha").click());
    await input("renamed");
    await act(async () => button("Rename").click());
    await act(async () => button("Save").click());
    expect(button("Save").disabled).toBe(false);
    expect(button("renamed")).toBeTruthy();
    expect(document.body.textContent).toContain("Your draft is kept");
    expect(document.body.textContent).not.toContain("may have completed");
  });
});
