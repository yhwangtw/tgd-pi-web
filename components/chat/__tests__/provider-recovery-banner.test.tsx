// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { classifyProviderError } from "@/lib/provider-recovery";
import { ProviderRecoveryBanner, type ProviderRecoveryView } from "../ProviderRecoveryBanner";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const openModels = vi.fn();
beforeEach(() => {
  setLocale("en");
  openModels.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(message: string, busy = false) {
  const recovery: ProviderRecoveryView = { message, ...classifyProviderError(message), candidate: null, automatic: false };
  await act(async () => root.render(<ProviderRecoveryBanner recovery={recovery} busy={busy}
    onRetryWithModel={vi.fn()} onAutomaticChange={vi.fn()} onDismiss={vi.fn()} onOpenModels={openModels} />));
}

it.each(["en", "zh"] as const)("offers account guidance and a settings action for a rejected saved login (%s)", async locale => {
  setLocale(locale);
  await render("Perch AI: Not authorized");
  expect(host.querySelector("p")?.textContent).toContain(locale === "en" ? "could not verify your sign-in" : "未通過登入驗證");
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === (locale === "en" ? "Check connection" : "檢查連線"));
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(openModels).toHaveBeenCalledOnce();
});

it("gives a next step when an unknown failure has no fallback model", async () => {
  await render("The provider returned an unexpected response");
  expect(host.querySelector("p")?.textContent).toContain("Check the error details and connection settings");
  expect(host.textContent).not.toContain("Resume with");
});

it("keeps settings unavailable during an existing recovery operation", async () => {
  await render("Not authorized", true);
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === "Check connection")!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(openModels).not.toHaveBeenCalled();
});
