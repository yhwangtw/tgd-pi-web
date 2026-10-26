import { test as base, expect } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withFixtureMessages } from "./session-response-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const model = { provider: "feedback-fixture", id: "offline" };
const assistant = (content: Record<string, unknown>[]) => ({ role: "assistant", provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: "stop" });
const calls = [
  { type: "toolCall", toolCallId: "a", toolName: "read", input: { path: "a.ts" } },
  { type: "toolCall", toolCallId: "b", toolName: "write", input: { path: "b.ts", content: "example" } },
];

type Feedback = { open: () => Promise<void>; send: (event: Record<string, unknown>) => void; end: (failed?: boolean) => void };
const test = base.extend<{ feedback: Feedback }>({
  feedback: async ({ page, baseURL }, use) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local fixtures only");
    await page.addInitScript(() => { localStorage.setItem("pi-composer-hints", "off"); localStorage.setItem("pi-locale", "en"); });
    let running = true;
    let messages: Record<string, unknown>[] = [{ role: "user", content: "UI feedback fixture", timestamp: Date.now() }];
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      if (event.type === "message_end") messages = [...messages, event.message as Record<string, unknown>];
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": new URL(baseURL).origin });
      res.write("retry: 60000\n\n"); streams.add(res); res.on("close", () => streams.delete(res));
      send({ type: "connected", sessionId: SESSION });
      send({ type: "session_snapshot", sessionId: SESSION, state: { isStreaming: running, model, thinkingLevel: "off" }, streamingMessage: null });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const forbidden: string[] = [];
    await page.route("**/api/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (["GET", "HEAD"].includes(req.method())) return route.continue();
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (path === `/api/agent/${SESSION}` && req.postDataJSON()?.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
      forbidden.push(`${req.method()} ${path}`); return route.fulfill({ status: 403, json: { error: "No inference or mutations" } });
    });
    await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?|$)`), async route => {
      const response = await route.fetch();
      const data = withFixtureMessages(await response.json(), messages, messages.map((_, i) => `feedback-${i}`));
      await route.fulfill({ response, json: { ...data, agentState: { running, state: { isStreaming: running, model } } } });
    });
    await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.continue({ url: streamURL }));
    try {
      await use({
        open: async () => { await page.goto(`/?session=${SESSION}`); await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true"); await expect.poll(() => streams.size).toBe(1); },
        send,
        end: (failed = false) => { running = false; const final = assistant([{ type: "text", text: failed ? "One tool failed." : "Finished." }]); send({ type: "message_end", message: final }); send({ type: "agent_end", messages: [final] }); },
      });
      expect(forbidden).toEqual([]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

test("real SSE keeps tool preparation, parallel execution and final outcome distinct", async ({ page, feedback }) => {
  await page.setViewportSize({ width: 1062, height: 850 });
  await feedback.open();
  await expect(page.locator('[data-run-phase="waiting_model"]')).toBeVisible();
  feedback.send({ type: "message_start", message: assistant([{ type: "thinking", thinking: "Plan the checks." }]) });
  await expect(page.locator('[data-run-phase="thinking"]')).toBeVisible();
  feedback.send({ type: "message_update", message: assistant([calls[0]]) });
  await expect(page.locator('[data-run-phase="preparing_tools"]')).toBeVisible();
  await expect(page.locator('[data-tool-state="preparing"]')).toBeVisible();
  await expect(page.getByTestId("streaming-speed")).not.toContainText("token/s");
  feedback.send({ type: "message_end", message: assistant(calls) });
  const workLog = page.locator('[data-work-log-state="running"]');
  await expect(workLog).toBeVisible(); await workLog.locator(":scope > button").click();
  await expect(workLog.locator('[data-tool-state="pending"]')).toHaveCount(2);
  feedback.send({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  feedback.send({ type: "tool_execution_start", toolCallId: "b", toolName: "write" });
  const group = workLog;
  await expect(group.locator('[data-tool-state="running"]')).toHaveCount(2);
  feedback.send({ type: "message_end", message: { role: "toolResult", toolCallId: "a", content: [], timestamp: Date.now() } });
  feedback.send({ type: "tool_execution_end", toolCallId: "a" });
  await expect(group.locator('[data-tool-state="success"]')).toHaveCount(1);
  await expect(group.locator('[data-tool-state="running"]')).toHaveCount(1);
  feedback.send({ type: "message_end", message: { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "Permission denied" }], isError: true, timestamp: Date.now() } });
  feedback.send({ type: "tool_execution_end", toolCallId: "b" });
  await expect(group.locator('[data-tool-state="error"]')).toHaveCount(1);
  feedback.end(true);
  await expect(page.locator('[data-work-log-state="error"]')).toBeVisible();
  await expect(page.locator('[data-run-phase]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("tool-result-evidence.png") });
});

for (const style of ["original", "trae"]) {
  for (const width of [320, 390, 1062, 1440]) {
    test(`${style} Models dialog at ${width}px respects viewport and configured width`, async ({ page, feedback }) => {
      await page.addInitScript(({ style, width }) => {
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-theme", style === "trae" && width <= 1062 ? "dark" : "light");
      }, { style, width });
      await page.setViewportSize({ width, height: 850 });
      await page.route("**/api/models-config", route => route.fulfill({ headers: { etag: '"feedback"' }, json: { providers: { "fixture-provider": { api: "openai-completions", models: [{ id: "thinking-model", reasoning: true }] } } } }));
      await feedback.open(); feedback.end();
      const composer = page.getByRole("textbox", { name: "Message…", exact: true });
      await composer.fill("Keep this draft");
      if (width <= 700) {
        await page.getByRole("log", { name: "Conversation", exact: true }).click({ position: { x: 4, y: 4 } });
        await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("button", { name: "Models", exact: true }).click();
      } else {
        await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Models", exact: true }).click();
      }
      const dialog = page.getByTestId("models-config-dialog");
      await expect(dialog).toBeVisible();
      await expect.poll(async () => {
        const box = await dialog.boundingBox();
        return box ? Math.abs(box.x + box.width / 2 - width / 2) : 999;
      }).toBeLessThanOrEqual(1);
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1); expect(box.y + box.height).toBeLessThanOrEqual(851);
      if (width > 700) { expect(box.width).toBe(900); expect(Math.abs(box.y + box.height / 2 - 425)).toBeLessThanOrEqual(1); }
      else { expect(box.width).toBe(width); expect(box.height).toBe(850); }
      await expect(dialog.getByRole("img", { name: /^T: reasoning/ })).toHaveAttribute("title", /Tool permissions are configured separately/);
      if (width <= 700) {
        await dialog.getByTestId("provider-health-nav").click();
        await expect(dialog.getByTestId("models-config-detail")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
        await dialog.getByRole("button", { name: "Back to models", exact: true }).click();
        await expect(dialog.getByTestId("models-config-nav")).toBeVisible();
      }
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`models-${style}-${width}.png`) });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(composer).toHaveValue("Keep this draft");
      await expect(dialog).toBeHidden();
    });
  }
}
