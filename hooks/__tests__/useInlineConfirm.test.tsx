// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useInlineConfirm } from "../useInlineConfirm";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("cancels an obsolete review on scope change or unmount without approving it", async () => {
  let confirm!: (text: string) => Promise<boolean>;
  function Harness({ scope }: { scope: string }) {
    const request = useInlineConfirm(scope);
    useLayoutEffect(() => { confirm = request.confirm; }, [request.confirm]);
    return <>{request.confirmation}<input aria-label="Composer" /></>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let unmounted = false;
  try {
    await act(async () => root.render(<Harness scope="a" />));
    const composer = host.querySelector("input")!; composer.focus();
    let pending!: Promise<boolean>;
    await act(async () => { pending = confirm("Delete from A?"); });
    expect(document.activeElement).toBe(composer);
    expect(host.querySelector('[aria-modal="true"]')).toBeNull();
    await act(async () => root.render(<Harness scope="b" />));
    expect(await pending).toBe(false);
    expect(host.textContent).not.toContain("Delete from A?");
    await act(async () => { pending = confirm("Delete from B?"); });
    await act(async () => root.unmount()); unmounted = true;
    expect(await pending).toBe(false);
  } finally { if (!unmounted) await act(async () => root.unmount()); host.remove(); }
});
