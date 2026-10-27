// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionPolicy } from "../CompactionPolicy";
import { setLocale } from "@/lib/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); container?.remove(); root = null; });
async function render(enabled: boolean, tokens = 83_616) {
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const onCompact = vi.fn().mockResolvedValue(undefined);
  await act(async () => root?.render(<CompactionPolicy usage={{ tokens, percent: tokens / 1000, contextWindow: 100_000 }} settings={{ enabled, reserveTokens: 16_384, keepRecentTokens: 20_000 }} busy={false} onCompact={onCompact} />));
  return onCompact;
}
describe("compaction policy disclosure", () => {
  it("shows the resolved threshold at 80% without implying compaction already starts there", async () => {
    await render(true, 80_000);
    expect(container?.querySelector("summary")?.textContent).toContain("Auto above ≈83.6%");
    expect(container?.querySelector("[data-pressure]")?.getAttribute("data-pressure")).toBe("false");
    expect(container?.querySelector("button")).toBeNull();
    expect(container?.querySelector("details")?.open).toBe(true);
    expect(container?.textContent).toContain("83,616 context tokens");
    expect(container?.textContent).toContain("Reserve 16,384 tokens; retain about 20,000 recent tokens");
  });
  it("requires strictly exceeding the token threshold before suggesting manual compaction", async () => {
    await render(true);
    await act(async () => root?.render(<CompactionPolicy variant="pressure" usage={{ tokens: 83_616, percent: 83.616, contextWindow: 100_000 }} settings={{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }} busy={false} onCompact={vi.fn()} />));
    expect(container?.querySelector("[data-testid=compaction-pressure]")).toBeNull();
    await act(async () => root?.render(<CompactionPolicy variant="pressure" usage={{ tokens: 83_617, percent: 83.617, contextWindow: 100_000 }} settings={{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }} busy={false} onCompact={vi.fn()} />));
    expect(container?.querySelector("[data-pressure]")?.getAttribute("data-pressure")).toBe("true");
    expect(container?.querySelector("button")?.textContent).toBe("Compact");
  });
  it("explains disabled automation without a permanent pressure bar or duplicate manual action", async () => {
    await render(false, 99_000);
    expect(container?.querySelector("summary")?.textContent).toContain("Auto off · manual compaction");
    expect(container?.textContent).toContain("Automatic threshold and overflow compaction are disabled");
    expect(container?.querySelector("[data-pressure]")?.getAttribute("data-pressure")).toBe("false");
    expect(container?.querySelector("button")).toBeNull();
    await act(async () => root?.render(<CompactionPolicy variant="pressure" usage={{ tokens: 99_000, percent: 99, contextWindow: 100_000 }} settings={{ enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 }} busy={false} onCompact={vi.fn()} />));
    expect(container?.querySelector("[data-testid=compaction-pressure]")).toBeNull();
  });
  it("shows a saved model's resolved threshold before runtime usage exists without inventing usage", async () => {
    await render(true);
    await act(async () => root?.render(<CompactionPolicy usage={null} contextWindow={1_000_000} settings={{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }} busy={false} onCompact={vi.fn()} />));
    expect(container?.textContent).toContain("Context —");
    expect(container?.textContent).toContain("≈98.4%");
    expect(container?.textContent).toContain("983,616 context tokens");
    expect(container?.querySelector("[data-pressure]")?.getAttribute("data-pressure")).toBe("false");
  });

});
