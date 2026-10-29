import { test as base, expect } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withFixtureMessages } from "./session-response-fixture";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const model = { provider: "activity-fixture", id: "offline" };
const target = "src/components/chat/ConversationActivityMonitor.tsx";
const assistant = (content: Record<string, unknown>[]) => ({ role: "assistant", provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: "stop" });

type ActivityFixture = {
  open: (quiet?: boolean) => Promise<void>;
  tool: () => void;
  parallel: () => void;
  disconnect: () => void;
  resume: () => void;
  thinking: (text: string) => void;
  keepalive: () => void;
  finish: () => void;
};

// Native loopback SSE drives the real browser reducer. Every model/tool event
// is synthetic; all agent commands are blocked, so no model or tool can run.
const test = base.extend<{ activity: ActivityFixture }>({
  activity: async ({ page, baseURL, request }, use) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Requires isolated fixture server");
    await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
    let running = true;
    let phase: Record<string, unknown> = { kind: "thinking" };
    let startedAt = Date.now() - 45_000;
    let lastProgressAt = Date.now() - 2_000;
    let streamingMessage: Record<string, unknown> | null = assistant([{ type: "thinking", thinking: "Inspecting the current request." }]);
    const messages: Record<string, unknown>[] = Array.from({ length: 4 }, (_, i) => [
      { role: "user", content: `Earlier question ${i}`, timestamp: i + 1 },
      assistant([{ type: "text", text: Array.from({ length: 25 }, (_, p) => `Earlier context ${i}, paragraph ${p}.`).join("\n\n") }]),
    ]).flat();
    messages.push({ role: "user", content: "Show actual activity while tools are running.", timestamp: Date.now() });
    const state = () => ({ isStreaming: running, model, thinkingLevel: "off", runState: running ? {
      id: "activity-current-run", startedAt, lastProgressAt, observedAt: Date.now(), phase,
    } : null });
    let accepting = true;
    let sequence = 0;
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      for (const stream of streams) stream.write(`id: activity:${++sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const server = createServer((_req, response) => {
      if (!accepting) { response.writeHead(503, { "Access-Control-Allow-Origin": new URL(baseURL).origin }); response.end(); return; }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": new URL(baseURL).origin });
      response.write("retry: 60000\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
      response.write(`data: ${JSON.stringify({ type: "connected", sessionId: SESSION })}\n\n`);
      response.write(`id: activity:${sequence}\ndata: ${JSON.stringify({ type: "session_snapshot", sessionId: SESSION, state: state(), streamingMessage, bashRun: null })}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const forbidden: string[] = [];
    await page.route("**/api/**", async route => {
      const req = route.request();
      if (["GET", "HEAD"].includes(req.method())) return route.continue();
      const path = new URL(req.url()).pathname;
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}` && req.postDataJSON()?.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
      if (isFixtureReadReceipt(req)) return route.continue();
      forbidden.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Activity fixture forbids mutations" } });
    });
    // Seed immutable metadata once. Re-fetching inside the route can outlive
    // the page when agent_end schedules its final background session refresh.
    const seedResponse = await request.get(`/api/sessions/${SESSION}`);
    expect(seedResponse.ok()).toBe(true);
    const seed = await seedResponse.json();
    await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?|$)`), async route => {
      const data = withFixtureMessages(seed, messages, messages.map((_, i) => `activity-${i}`));
      await route.fulfill({ json: { ...data, agentState: { running: true, state: state() } } });
    });
    await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.continue({ url: streamURL }));
    try {
      await use({
        open: async (quiet = false) => {
          startedAt = Date.now() - (quiet ? 150_000 : 45_000);
          lastProgressAt = Date.now() - (quiet ? 110_000 : 2_000);
          await page.goto(`/?session=${SESSION}`);
          await expect(page.getByTestId("run-monitor")).toHaveAttribute("data-run-phase", "thinking");
          await expect.poll(() => streams.size).toBe(1);
        },
        tool: () => {
          const message = assistant([{ type: "thinking", thinking: "Checking the file returned by this provider." },
            { type: "toolCall", toolCallId: "activity-read", toolName: "read", input: { path: target } }]);
          messages.push(message); streamingMessage = null; lastProgressAt = Date.now();
          phase = { kind: "running_tools", tools: [{ id: "activity-read", name: "read", startedAt: Date.now() - 8_000 }] };
          send({ type: "message_end", message });
          send({ type: "tool_execution_start", toolCallId: "activity-read", toolName: "read", toolActivity: (phase.tools as unknown[])[0], observedAt: Date.now() });
        },
        parallel: () => {
          const calls = [
            { type: "toolCall", toolCallId: "parallel-a", toolName: "read", input: { path: "src/first.ts" } },
            { type: "toolCall", toolCallId: "parallel-b", toolName: "bash", input: { command: "printf 'activity'; sleep 15; printf 'finished'" } },
            { type: "toolCall", toolCallId: "parallel-c", toolName: "subagent", input: { tasks: [{ agent: "scout", task: "Inspect" }, { agent: "reviewer", task: "Review" }] } },
          ];
          const message = assistant(calls); messages.push(message); streamingMessage = null; lastProgressAt = Date.now();
          const tools = calls.map((call, index) => ({ id: call.toolCallId, name: call.toolName, startedAt: Date.now() - (index + 1) * 4_000,
            ...(call.toolName === "subagent" ? { children: [{ id: "0", label: "scout", state: "completed" }, { id: "1", label: "reviewer", state: "running", target: "read · src/review.ts" }] } : {}) }));
          phase = { kind: "running_tools", tools };
          send({ type: "message_end", message });
          for (const tool of tools) send({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, toolActivity: tool, observedAt: Date.now() });
        },
        disconnect: () => { accepting = false; for (const stream of streams) stream.end(); },
        resume: () => { accepting = true; },
        thinking: text => {
          streamingMessage = assistant([{ type: "thinking", thinking: text }]); phase = { kind: "thinking" }; lastProgressAt = Date.now();
          send({ type: "message_update", message: streamingMessage });
        },
        keepalive: () => {
          for (const stream of streams) stream.write(": keepalive\n\n");
          send({ type: "run_timing", timingId: "activity-diagnostic", stage: "accepted", elapsedMs: 0 });
        },
        finish: () => {
          const result = { role: "toolResult", toolCallId: "activity-read", content: [{ type: "text", text: "Offline file contents." }], timestamp: Date.now() };
          messages.push(result); send({ type: "message_end", message: result });
          send({ type: "tool_execution_end", toolCallId: "activity-read", toolName: "read", result });
          const message = assistant([{ type: "text", text: "Finished the offline activity fixture." }]);
          messages.push(message); streamingMessage = null; running = false;
          send({ type: "message_end", message }); send({ type: "agent_end", messages: [message] });
        },
      });
      expect(forbidden).toEqual([]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
});

for (const [label, width, height, style, theme] of [
  ["desktop", 1440, 960, "original", "dark"], ["mobile", 390, 850, "original", "dark"],
  ["small-trae", 320, 700, "trae", "light"], ["desktop-trae", 1440, 960, "trae", "light"],
] as const) {
  test(`${label}: activity remains visible while reading history and tools disclose a current target`, async ({ page, activity }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(({ style, theme }) => {
      localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-theme", theme); localStorage.setItem("pi-locale", "zh");
    }, { style, theme });
    await activity.open();
    const monitor = page.getByTestId("run-monitor");
    await expect(monitor).toHaveCount(1);
    await expect(page.locator("[data-transcript-scroll]").getByTestId("run-monitor")).toHaveCount(0);
    await page.locator("[data-transcript-scroll]").evaluate(node => { node.scrollTop = 0; });
    await expect(monitor).toBeInViewport();
    activity.tool();
    await expect(monitor).toHaveAttribute("data-run-phase", "running_tools");
    await expect(page.getByTestId("run-tool-preview")).toHaveText(target);
    const log = page.locator('[data-work-log-state="running"]').last();
    await expect(log).toHaveAttribute("data-work-log-expanded", "false");
    await expect(page.getByTestId("active-work-summary")).toHaveText(`read · ${target}`);
    await expect(page.getByTestId("run-status-elapsed")).not.toHaveText(/總耗時 [0-9]s$/);
    await page.reload();
    await expect(page.getByTestId("run-tool-preview")).toHaveText(target);
    await expect(monitor).toBeInViewport();
    await page.locator("[data-transcript-scroll]").evaluate(node => { node.scrollTop = 0; });
    const totals = [page.getByTestId("run-status-elapsed"), log.getByTestId("work-log-elapsed")];
    expect(Math.abs(seconds(await totals[0].innerText()) - seconds(await totals[1].innerText()))).toBeLessThanOrEqual(1);
    if (width < 600) {
      await monitor.getByRole("button", { name: "展開執行明細" }).click();
      await expect(monitor.getByTestId("run-details")).toContainText(target);
      await monitor.getByTestId("run-details").getByRole("button", { name: "在工作紀錄開啟 read" }).click();
    } else await monitor.getByTestId("run-tool-preview").click();
    await expect(log).toHaveAttribute("data-work-log-expanded", "true");
    const tool = log.locator('[data-tool-call-id="activity-read"]');
    await expect(tool.getByRole("button").first()).toBeFocused();
    await expect(tool.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
    try { await expect(tool.getByRole("button").first()).toBeInViewport(); }
    catch (error) {
      console.log("NAVIGATION_GEOMETRY", await page.evaluate(() => {
        const pick = (selector: string) => { const el = document.querySelector(selector) as HTMLElement; const rect = el?.getBoundingClientRect(); return { rect: rect?.toJSON(), top: el?.scrollTop, height: el?.scrollHeight }; };
        return { transcript: pick("[data-transcript-scroll]"), tool: pick('[data-tool-call-id="activity-read"]'), log: pick('[data-work-log-state="running"]'), body: pick('[data-work-log-state="running"] > div:last-child') };
      }));
      await page.screenshot({ path: test.info().outputPath("navigation-failure.png") }); throw error;
    }
    // composer-shell is the padded draft area; its parent is the actual border.
    const composer = page.getByTestId("composer-shell").locator("..");
    const [statusBox, composerBox] = await Promise.all([monitor.boundingBox(), composer.boundingBox()]);
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const visuals = await monitor.locator('[class*="runStatusVisual"]').boundingBox();
    expect(Math.abs(visuals!.x - composerBox!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(visuals!.width - composerBox!.width)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: test.info().outputPath(`activity-${label}.png`) });
    await log.getByRole("button").first().click();
    await expect(log).toHaveAttribute("data-work-log-expanded", "false");
    activity.finish();
    await expect(monitor).toHaveCount(0);
    await expect(page.getByTestId("active-work-summary")).toHaveCount(0);
    await expect(log).toHaveCount(0);
    await expect(page.getByText("Finished the offline activity fixture.", { exact: true })).toBeAttached();
  });
}

function seconds(label: string) {
  const minutes = /(\d+)m/.exec(label)?.[1] ?? "0";
  const seconds = /(\d+)s/.exec(label)?.[1] ?? "0";
  return Number(minutes) * 60 + Number(seconds);
}

test("keepalives cannot disguise quiet reasoning, and real provider content restores recent activity", async ({ page, activity }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await activity.open(true);
  const monitor = page.getByTestId("run-monitor");
  const freshness = page.getByTestId("run-last-progress");
  await expect(monitor).toHaveAttribute("data-progress-state", "delayed");
  await expect(monitor).toContainText("Last state: Thinking");
  await monitor.getByRole("button", { name: "Show activity details" }).click();
  await expect(page.getByTestId("run-connection")).toHaveText("Connected · awaiting new progress");
  await expect(monitor).not.toContainText("still working");
  await page.screenshot({ path: test.info().outputPath("activity-quiet.png") });
  const before = seconds(await freshness.innerText());
  activity.keepalive();
  await page.clock.runFor(4_000);
  await expect.poll(async () => seconds(await freshness.innerText())).toBeGreaterThanOrEqual(before + 3);
  const thinking = page.getByRole("button", { name: /^Thinking/ }).last();
  await expect(thinking).toHaveAttribute("aria-expanded", "false");
  await thinking.click();
  activity.thinking("Actual provider reasoning was received.");
  await expect(page.getByText("Actual provider reasoning was received.", { exact: true })).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(monitor).toHaveAttribute("data-progress-state", "normal");
  await expect(page.getByTestId("run-connection")).toHaveText("Connected");
  expect(seconds(await freshness.innerText())).toBeLessThanOrEqual(2);
});


test("parallel tools and upstream children retain identity, elapsed time and navigation after reconnect", async ({ page, activity }) => {
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await activity.open(); activity.parallel();
  const monitor = page.getByTestId("run-monitor");
  await expect(monitor).toContainText("Running 3 tools");
  await monitor.getByRole("button", { name: "Show activity details" }).click();
  await expect(monitor.getByTestId("run-tool-row")).toHaveCount(3);
  await expect(monitor.locator('[data-child-state="completed"]')).toContainText("scout");
  await expect(monitor.locator('[data-child-state="running"]')).toContainText("reviewer");
  const before = seconds(await monitor.getByTestId("run-tool-elapsed").nth(1).innerText());
  activity.disconnect();
  await expect(monitor).toHaveAttribute("data-progress-state", "reconnecting");
  await expect(page.getByTestId("run-connection")).toContainText("reconnecting");
  activity.resume();
  await expect(monitor).toHaveAttribute("data-progress-state", "normal", { timeout: 20_000 });
  expect(seconds(await monitor.getByTestId("run-tool-elapsed").nth(1).innerText())).toBeGreaterThanOrEqual(before);
  await monitor.getByTestId("run-details").getByRole("button", { name: "Open bash in work log" }).click();
  const tool = page.locator('[data-tool-call-id="parallel-b"]');
  await expect(tool.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(tool.getByRole("button").first()).toBeFocused();
  await expect(tool).toContainText("sleep 15");
  await expect(page.locator('[data-tool-call-id="parallel-a"]').getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
});
