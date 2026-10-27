// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunTranscript as Transcript } from "@/lib/agent-run-types";
import { setLocale } from "@/lib/i18n";
import { resetRequestState } from "@/lib/request-state";
import { AgentRunTranscript } from "../AgentRunTranscript";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { resetRequestState(); vi.unstubAllGlobals(); });

it("renders and refreshes saved SDK run messages with the normal conversation renderer", async () => {
  setLocale("en");
  const run: AgentRun = { id: "sdk-background", name: "Project review", cwd: "/fixture", prompt: "Review", toolNames: ["read"], trigger: "manual", status: "completed", createdAt: "2026-10-26T00:00:00Z", sessionId: "dw_saved-sdk-id" };
  const transcript: Transcript = { messages: [
    { role: "user", content: "Review the source", timestamp: 1 },
    { role: "assistant", provider: "fixture", model: "fixture", content: [{ type: "text", text: "Review complete" }], timestamp: 2 },
    { role: "custom", customType: "pi-web-compaction", display: true, content: "Saved background summary" },
  ], truncated: true, updatedAt: "2026-10-26T00:01:00Z" };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(transcript)));
  vi.stubGlobal("fetch", fetcher);
  const close = vi.fn();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AgentRunTranscript run={run} onClose={close} />));
    expect(fetcher).toHaveBeenCalledWith("/api/agent-runs/sdk-background/transcript", expect.objectContaining({ cache: "no-store" }));
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.textContent).toContain("Review the source");
    expect(panel.textContent).toContain("Review complete");
    expect(panel.textContent).toContain("Earlier context summary");
    expect(panel.textContent).not.toContain("pi-web-compaction");
    expect(panel.querySelector("details")?.open).toBe(false);
    expect(panel.textContent).toContain("Showing recent activity");
    expect(panel.querySelector('[data-chat-cwd="/fixture"]')).not.toBeNull();
    await act(async () => [...panel.querySelectorAll("button")].find(button => button.textContent === "Refresh activity")!.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(close).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
