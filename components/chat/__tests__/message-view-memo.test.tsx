// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@/lib/types";
import { MessageView } from "../MessageView";

const fixture = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../UserMessageView", () => ({ UserMessageView: ({ onQuote }: { onQuote?: (text: string) => void }) => {
  fixture.renders++;
  return <button onClick={() => onQuote?.("selected user text")}>Quote user</button>;
} }));
vi.mock("../AssistantMessageView", () => ({ AssistantMessageView: ({ onQuote }: { onQuote?: (text: string) => void }) => {
  fixture.renders++;
  return <button onClick={() => onQuote?.("selected assistant text")}>Quote assistant</button>;
} }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; fixture.renders = 0; });

describe("memoized message quoting", () => {
  for (const role of ["user", "assistant"] as const) {
    it(`keeps ${role} quote entry context without rerendering stable history`, async () => {
      const message: AgentMessage = role === "user"
        ? { role, content: "user text" }
        : { role, content: [{ type: "text", text: "assistant text" }], model: "fixture", provider: "fixture" };
      const onQuote = vi.fn();
      root = createRoot(host);
      await act(async () => root!.render(<MessageView message={message} entryId="entry" onQuote={onQuote} />));
      await act(async () => root!.render(<MessageView message={message} entryId="entry" onQuote={onQuote} />));
      expect(fixture.renders).toBe(1);
      await act(async () => host.querySelector("button")!.click());
      expect(onQuote).toHaveBeenCalledWith("entry", role, `selected ${role} text`);
    });
  }
});
