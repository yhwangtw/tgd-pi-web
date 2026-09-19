// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSessionStart } from "../useProjectSessionStart";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let actions: ReturnType<typeof useProjectSessionStart>;
const select = vi.fn();
const showPicker = vi.fn();
const start = vi.fn();
const fetchMock = vi.fn();

function Harness({ cwd = null }: { cwd?: string | null }) {
  const current = useProjectSessionStart(cwd, select, showPicker, start);
  useLayoutEffect(() => { actions = current; });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("new conversation project handoff", () => {
  it("asks for a project on New, then opens one conversation after selection", () => {
    actions.startNew();
    expect(showPicker).toHaveBeenLastCalledWith(true);
    expect(start).not.toHaveBeenCalled();
    actions.pickProject("/project");
    expect(select).toHaveBeenCalledWith("/project");
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), "/project");
    expect(showPicker).toHaveBeenLastCalledWith(false);
    actions.pickProject("/other");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("opens immediately when a project is already selected", async () => {
    await act(async () => root.render(<Harness cwd="/existing" />));
    actions.startNew();
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), "/existing");
    expect(showPicker).not.toHaveBeenCalledWith(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start a conversation after cancellation and ordinary project selection", () => {
    actions.startNew(); actions.closePicker(); actions.openPicker(); actions.pickProject("/project");
    expect(select).toHaveBeenCalledWith("/project");
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["typed", "default"])("starts after a successful %s directory selection", async (kind) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ cwd: "/resolved" })));
    actions.startNew();
    const result = kind === "typed" ? await actions.pickProjectPath("~/project") : await actions.pickDefaultProject();
    expect(result).toBeNull();
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), "/resolved");
    expect(fetchMock).toHaveBeenCalledWith(kind === "typed" ? "/api/cwd/validate" : "/api/default-cwd", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the New intent after validation failure and retries without duplicating a session", async () => {
    actions.startNew();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Directory not found" }), { status: 400 }));
    expect(await actions.pickProjectPath("/missing")).toBe("Directory not found");
    expect(start).not.toHaveBeenCalled();
    expect(showPicker).not.toHaveBeenCalledWith(false);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ cwd: "/valid" })));
    expect(await actions.pickProjectPath("/valid")).toBeNull();
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), "/valid");
  });

  it.each(["cancel", "unmount", "other-project"])("ignores a late path response after %s", async (action) => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    actions.startNew();
    const pending = actions.pickProjectPath("/slow");
    if (action === "cancel") { actions.closePicker(); actions.openPicker(); }
    if (action === "unmount") await act(async () => root.render(null));
    if (action === "other-project") actions.pickProject("/chosen");
    resolve(new Response(JSON.stringify({ cwd: "/slow" })));
    await pending;
    expect(select).not.toHaveBeenCalledWith("/slow");
    if (action === "other-project") expect(start).toHaveBeenCalledExactlyOnceWith(expect.any(String), "/chosen");
    else expect(start).not.toHaveBeenCalled();
  });
});
