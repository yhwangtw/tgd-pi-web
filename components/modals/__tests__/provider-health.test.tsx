// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderHealth } from "../ProviderHealth";
import type { ProviderHealthReport } from "@/lib/provider-health";

const state = vi.hoisted(() => ({ report: null as ProviderHealthReport | null }));
vi.mock("@/hooks/useRequestResource", () => ({ fetchJson: vi.fn(), useRequestResource: () => ({ data: state.report }) }));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

describe("provider health filters", () => {
  it("shows a true empty attention state and one OAuth label after switching filters", async () => {
    state.report = {
      checkedAt: "2026-09-05T00:00:00Z",
      summary: { ready: 1, total: 2, warning: 0, invalid: 0, needsAuth: 1 },
      coverage: { credentialReadiness: "checked", localCatalog: "checked", quotaAndBilling: "not_checked", upstreamAvailability: "not_checked" },
      providers: [
        { id: "provider/long-full-id", name: "Configured vendor", status: "ready", authType: "oauth", authSource: "OAuth", storedCredential: true, modelCount: 1, availableModelCount: 1 },
        { id: "empty", name: "Unconfigured vendor", status: "needs_auth", storedCredential: false, modelCount: 1, availableModelCount: 0 },
      ],
    };
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<ProviderHealth />));
    expect(container.textContent).toContain("No providers need attention");
    expect(container.querySelectorAll("article")).toHaveLength(0);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    await act(async () => buttons[1].click());
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("article")?.textContent?.match(/OAuth/g)).toHaveLength(1);
    expect(container.querySelector("code")?.textContent).toBe("provider/long-full-id");
    await act(async () => buttons[2].click());
    expect(container.querySelectorAll("article")).toHaveLength(2);
    state.report.providers[0].status = "warning";
    state.report = { ...state.report };
    await act(async () => { buttons[0].click(); root.render(<ProviderHealth />); });
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("article")?.textContent).toContain("Configured vendor");
  });
});
