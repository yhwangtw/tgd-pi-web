// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkflowCommand } from "../use-workflow-command";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useWorkflowCommand>;
function Harness({ scope, send }: { scope?: string; send: (message: string) => Promise<boolean> }) {
  const command = useWorkflowCommand(scope, send);
  useLayoutEffect(() => { current = command; });
  return <output>{command.pending ? "pending" : "idle"}</output>;
}
function deferred() {
  let resolve: (result: boolean) => void = () => {};
  const promise = new Promise<boolean>(complete => { resolve = complete; });
  return { promise, resolve };
}
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(scope: string | undefined, send: (message: string) => Promise<boolean>) {
  await act(async () => root.render(<Harness scope={scope} send={send} />));
}

it("rejects duplicate workflow commands synchronously until success or a false result settles", async () => {
  const pending = deferred();
  const send = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(true);
  await render("a", send);
  let first!: Promise<boolean>;
  await act(async () => { first = current.run("/plan"); expect(await current.run("/plan exit")).toBe(false); });
  expect(send).toHaveBeenCalledExactlyOnceWith("/plan");
  expect(current.pending).toBe(true);
  await act(async () => { pending.resolve(false); expect(await first).toBe(false); });
  expect(current.pending).toBe(false);
  await act(async () => expect(await current.run("/plan exit")).toBe(true));
  expect(send).toHaveBeenCalledTimes(2);
});

it("keeps B pending when an earlier A request completes after a session switch", async () => {
  const a = deferred(), b = deferred();
  const sendA = vi.fn(() => a.promise), sendB = vi.fn(() => b.promise);
  await render("a", sendA);
  let requestA!: Promise<boolean>, requestB!: Promise<boolean>;
  await act(async () => { requestA = current.run("/plan"); });
  await render("b", sendB);
  expect(current.pending).toBe(false);
  await act(async () => { requestB = current.run("/plan exit"); });
  expect(current.pending).toBe(true);
  await act(async () => { a.resolve(true); await requestA; });
  expect(current.pending).toBe(true);
  await act(async () => expect(await current.run("/goal pause")).toBe(false));
  expect(sendB).toHaveBeenCalledOnce();
  await act(async () => { b.resolve(true); await requestB; });
  expect(current.pending).toBe(false);
});

it("retains each session guard during A to B to A round trips", async () => {
  const a = deferred(), b = deferred();
  const sendA = vi.fn(() => a.promise), sendB = vi.fn(() => b.promise);
  await render("a", sendA);
  let requestA!: Promise<boolean>, requestB!: Promise<boolean>;
  await act(async () => { requestA = current.run("/plan"); });
  await render("b", sendB);
  await act(async () => { requestB = current.run("/plan exit"); });
  await render("a", sendA);
  expect(current.pending).toBe(true);
  await act(async () => expect(await current.run("/plan execute")).toBe(false));
  expect(sendA).toHaveBeenCalledOnce();
  await act(async () => { a.resolve(true); await requestA; });
  expect(current.pending).toBe(false);
  await render("b", sendB);
  expect(current.pending).toBe(true);
  await act(async () => { b.resolve(true); await requestB; });
  expect(current.pending).toBe(false);
});

it("releases an unsaved-session guard after a rejected command so the user can retry", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("Transport disconnected")).mockResolvedValue(true);
  await render(undefined, send);
  await act(async () => { await expect(current.run("/plan exit")).rejects.toThrow("Transport disconnected"); });
  expect(current.pending).toBe(false);
  await act(async () => expect(await current.run("/plan exit")).toBe(true));
  expect(send).toHaveBeenCalledTimes(2);
});
