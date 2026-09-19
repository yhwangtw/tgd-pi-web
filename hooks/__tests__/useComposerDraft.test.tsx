// @vitest-environment jsdom
import { act, useLayoutEffect, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useComposerDraft } from "../useComposerDraft";
import { loadDraft } from "@/lib/composer-persistence";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("flushes a rapid switch and ignores a late acknowledgement from the previous session", async () => {
  localStorage.clear();
  let change!: (value: SetStateAction<string>) => void;
  function Draft({ id }: { id: string }) { const [value, setValue] = useComposerDraft(id); useLayoutEffect(() => { change = setValue; }, [setValue]); return <span>{value}</span>; }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<Draft id="a" />));
    const oldChange = change;
    await act(async () => change("last keystroke"));
    await act(async () => root.render(<Draft id="b" />));
    expect(loadDraft("a")).toBe("last keystroke");
    await act(async () => change("new draft"));
    await act(async () => oldChange(""));
    expect(host.textContent).toBe("new draft");
    window.dispatchEvent(new Event("pagehide"));
    expect(loadDraft("b")).toBe("new draft");
    await act(async () => root.render(<Draft id="a" />));
    expect(host.textContent).toBe("last keystroke");
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});
