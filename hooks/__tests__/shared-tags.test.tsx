// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTags } from "../useTags";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shares one load and optimistic tag changes across mounted panels, then rolls back a rejected update", async () => {
  let serverTags: Record<string, string[]> = { one: ["work"] };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ tags: serverTags }));
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); const root = createRoot(host);
  let first!: ReturnType<typeof useTags>; let second!: ReturnType<typeof useTags>;
  function Panel({ other = false }: { other?: boolean }) {
    const tags = useTags();
    if (other) second = tags; else first = tags;
    return <span>{tags.sessionTagsOf("one").join(",")}</span>;
  }
  try {
    await act(async () => root.render(<><Panel /><Panel other /></>));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.tags).toBe(second.tags);
    expect(host.textContent).toBe("workwork");
    serverTags = { one: ["work", "new"] };
    fetcher.mockImplementation(async (_url, init) => new Response(init?.method ? "{}" : JSON.stringify({ tags: serverTags })));
    let request!: Promise<void>;
    act(() => { request = first.setTag("one", "#NEW"); });
    expect(first.sessionTagsOf("one")).toEqual(["work", "new"]);
    expect(second.tags).toBe(first.tags);
    await act(async () => request);
    fetcher.mockImplementation(async (_url, init) => init?.method
      ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ tags: serverTags })));
    await act(async () => first.removeTag("one", "work"));
    expect(first.tags).toBe(second.tags);
    expect(second.sessionTagsOf("one")).toEqual(["work", "new"]);
    const stableLookup = first.sessionTagsOf("one");
    expect(first.sessionTagsOf("one")).toBe(stableLookup);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("does not let a load that began before an edit erase its optimistic state", async () => {
  const serverTags = { two: ["current", "added"] };
  let finishLoad!: (response: Response) => void;
  let finishMutation!: (response: Response) => void;
  const staleLoad = new Promise<Response>((resolve) => { finishLoad = resolve; });
  const mutation = new Promise<Response>((resolve) => { finishMutation = resolve; });
  const fetcher = vi.fn().mockReturnValueOnce(staleLoad).mockReturnValueOnce(mutation)
    .mockResolvedValue(new Response(JSON.stringify({ tags: serverTags })));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); const root = createRoot(host);
  let tags!: ReturnType<typeof useTags>;
  function Panel() { tags = useTags(); return null; }
  try {
    await act(async () => root.render(<Panel />));
    let loading!: Promise<void>; let editing!: Promise<void>;
    act(() => { loading = tags.load(); });
    act(() => { editing = tags.setTag("two", "added"); });
    await act(async () => { finishLoad(new Response(JSON.stringify({ tags: { two: ["current"] } }))); await loading; });
    expect(tags.sessionTagsOf("two")).toContain("added");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { finishMutation(new Response("{}")); await editing; });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(tags.sessionTagsOf("two")).toEqual(["current", "added"]);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
