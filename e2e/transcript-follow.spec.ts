import { test as base, expect, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const model = { provider: "scroll-fixture", id: "offline" };
const answer = (text: string) => ({
  role: "assistant", provider: model.provider, model: model.id, timestamp: 1,
  content: [{ type: "text", text }], stopReason: "stop",
});
const longText = (tail: string) => Array.from({ length: 35 }, (_, index) => `Scroll fixture paragraph ${index}.`).join("\n\n") + `\n\n${tail}`;

type OutputFixture = {
  open: (mode?: "smart" | "always" | "preserve") => Promise<void>;
  send: (event: Record<string, unknown>) => void;
  finish: (text: string) => void;
};

// Drive the real EventSource and message reducer over loopback SSE. The fixture
// never starts an agent or contacts a provider; only browser output is under test.
const test = base.extend<{ output: OutputFixture }>({
  output: async ({ page, baseURL }, use) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Requires a local fixture server");
    let running = true;
    let messages: Record<string, unknown>[] = [{ role: "user", content: "Scroll regression fixture", timestamp: 1 }];
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": new URL(baseURL).origin });
      response.write("retry: 60000\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
      send({ type: "connected", sessionId: SESSION });
      send({ type: "session_snapshot", sessionId: SESSION,
        state: { isStreaming: running, model, thinkingLevel: "off" },
        streamingMessage: answer(longText("Initial stream tail")), bashRun: null,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const forbidden: string[] = [];
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      if (["GET", "HEAD"].includes(req.method())) return route.continue();
      const path = new URL(req.url()).pathname;
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}` && req.postDataJSON()?.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
      forbidden.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Output fixture forbids mutations" } });
    });
    await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?|$)`), async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data,
        context: { ...data.context, messages, entryIds: messages.map((_, i) => `scroll-${i}`) },
        agentState: { running, state: { isStreaming: running, model } },
      } });
    });
    await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.continue({ url: streamURL }));
    try {
      await use({
        open: async (mode = "smart") => {
          await page.addInitScript((value) => localStorage.setItem("pi-scroll-follow-mode", value), mode);
          await page.goto(`/?session=${SESSION}`);
          await expect(page.getByText("Initial stream tail", { exact: true })).toBeAttached();
          await expect.poll(() => streams.size).toBe(1);
          await expectTailVisible(page, "Initial stream tail");
        },
        send,
        finish: (text) => {
          const message = answer(text); messages = [messages[0], message]; running = false;
          send({ type: "message_end", message });
          send({ type: "agent_end", messages: [message] });
        },
      });
      expect(forbidden).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});

async function expectTailVisible(page: Page, text: string) {
  const tail = page.getByText(text, { exact: true });
  await expect(tail).toBeInViewport();
  await expect.poll(async () => {
    const bottom = await tail.evaluate(node => node.getBoundingClientRect().bottom);
    const viewport = await page.locator("[data-transcript-scroll]").evaluate(node => node.getBoundingClientRect().bottom);
    return bottom - viewport;
  }).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toHaveCount(0);
}

test("smart follows a final-only chunk and remains at the tail after viewport resize", async ({ page, output }) => {
  await output.open();
  // No preceding message_update: this includes content still inside the 80ms throttle window.
  output.finish(longText("Initial stream tail") + "\n\n" + longText("Final committed tail"));
  await expectTailVisible(page, "Final committed tail");
  await page.setViewportSize({ width: 740, height: 540 });
  await expectTailVisible(page, "Final committed tail");
});

test("smart preserves an upward reader at completion and Latest returns to the tail", async ({ page, output }) => {
  await output.open();
  await page.locator("[data-transcript-scroll]").hover();
  await page.mouse.wheel(0, -500);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
  const before = await page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop);
  output.finish(longText("Initial stream tail") + "\n\n" + longText("Paused final tail"));
  await expect(page.getByText("Paused final tail", { exact: true })).toBeAttached();
  await expect(page.getByText("Paused final tail", { exact: true })).not.toBeInViewport();
  await expect.poll(() => page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop)).toBeLessThanOrEqual(before + 2);
  await page.getByRole("button", { name: "Jump to bottom" }).click();
  await expectTailVisible(page, "Paused final tail");
});

test("always follows terminal output without an assistant text stream", async ({ page, output }) => {
  await output.open("always");
  output.send({ type: "message_end", message: answer(longText("Initial stream tail")) });
  output.send({ type: "bash_start", command: "offline-output-fixture" });
  output.send({ type: "bash_chunk", chunk: Array.from({ length: 40 }, (_, i) => `Terminal line ${i}`).join("\n") });
  const terminal = page.locator("[data-transcript-scroll] pre").last();
  await expect(terminal).toContainText("Terminal line 39");
  await expect.poll(async () => {
    const bounds = await terminal.boundingBox();
    const viewport = await page.locator("[data-transcript-scroll]").boundingBox();
    return bounds!.y + bounds!.height - viewport!.y - viewport!.height;
  }).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toHaveCount(0);
});

test("preserve mode also applies to layout changes after a reply completes", async ({ page, output }) => {
  await output.open();
  output.finish(longText("Completed before preserving"));
  await expectTailVisible(page, "Completed before preserving");
  await page.getByRole("button", { name: "More composer controls" }).click();
  await page.getByRole("radio", { name: "Preserve position", exact: true }).click();
  const before = await page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop);
  await page.setViewportSize({ width: 1280, height: 420 });
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
  await expect(page.getByText("Completed before preserving", { exact: true })).not.toBeInViewport();
  await expect.poll(() => page.locator("[data-transcript-scroll]").evaluate(node => node.scrollTop)).toBeLessThanOrEqual(before + 2);
});
