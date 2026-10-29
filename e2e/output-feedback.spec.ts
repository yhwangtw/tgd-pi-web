import { test as base, expect, type Locator } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generationMessageKey, type GenerationMetrics } from "../lib/generation-metrics";
import type { AssistantMessage } from "../lib/types";
import type { RunRetryInfo } from "../lib/agent-run-state";
import { withFixtureMessages } from "./session-response-fixture";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const model = { provider: "output-feedback-fixture", id: "offline" };
const assistant = (content: Record<string, unknown>[]) => ({
  role: "assistant", provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: "stop",
});
type QueuedSteer = { id: string; message: string; deliveryMode: "steer" };
type CompactJob = {
  id: string; status: "running" | "completed"; reason: string; startedAt: number; revision: number;
  result?: { tokensBefore: number; estimatedTokensAfter: number };
};
type OutputFeedbackFixture = {
  commands: Record<string, unknown>[];
  open: () => Promise<void>;
  retry: () => void;
  continueAnswer: () => void;
  stop: () => void;
  deliverSteering: () => void;
  failTool: () => void;
  write: (text: string) => void;
  finish: () => void;
  compact: () => void;
  finishCompact: () => void;
};

// Native loopback SSE exercises the browser reducer, clocks and disclosures.
// Session reads use generated fixture metadata; every write is fulfilled here,
// including read receipts. No agent command or persistence reaches the server.
const test = base.extend<{ feedback: OutputFeedbackFixture }>({
  feedback: async ({ page, baseURL, request }, provideFixture) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)
      || !process.env.E2E_ROOT || !process.env.E2E_PROJECT_CWD) throw new Error("Isolated E2E fixture server required");
    await page.addInitScript(() => {
      localStorage.setItem("pi-composer-hints", "off"); localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-ui-style", "original"); localStorage.setItem("pi-theme", "dark");
    });
    const seedResponse = await request.get(`/api/sessions/${SESSION}`, { headers: { "X-Pi-Session-Tree": "flat-v2" } });
    expect(seedResponse.ok()).toBe(true);
    const seed = await seedResponse.json(); await seedResponse.dispose();
    const startedAt = Date.now() - 65_000;
    let lastProgressAt = Date.now();
    let running = true, sequence = 0;
    let retry: RunRetryInfo | null = null;
    let continuing = false;
    let compaction: CompactJob | null = null;
    let lastRunOutcome: "stopped" | null = null;
    let phase: Record<string, unknown> = { kind: "thinking" };
    let queued: QueuedSteer[] = [];
    let streamingMessage: Record<string, unknown> | null = assistant([{ type: "thinking", thinking: "Offline work is in progress." }]);
    const recordedMetrics: Record<string, GenerationMetrics> = {};
    const messages: Record<string, unknown>[] = [{ role: "user", content: "Exercise the output feedback fixture.", timestamp: startedAt }];
    const runState = () => ({
      id: "output-feedback-current-run", startedAt, lastProgressAt, observedAt: Date.now(), phase,
      ...(retry ? { retry } : {}), ...(continuing ? { continuing: true } : {}),
    });
    const state = () => ({
      isStreaming: running, model, thinkingLevel: "off", runState: running ? runState() : null,
      queuedFollowUps: queued, isCompacting: compaction?.status === "running",
      compaction: compaction ? { ...compaction, observedAt: Date.now() } : null,
      compactionQueue: [], autoCompactionEnabled: false,
    });
    const sessionData = () => {
      const data = withFixtureMessages(seed, messages, messages.map((_, i) => `output-feedback-${i}`));
      return { ...data, context: { ...data.context, model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off", generationMetrics: recordedMetrics } };
    };
    const snapshot = () => ({
      type: "session_snapshot", protocolVersion: 2, sessionId: SESSION, cursor: `output-feedback:${sequence}`,
      state: state(), sessionData: sessionData(), streamingMessage, phase: running ? phase : null,
      bashRun: null, lastRunOutcome,
    });
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      const frame = `id: output-feedback:${++sequence}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const stream of streams) stream.write(frame);
    };
    const persist = (message: Record<string, unknown>, generationMetrics?: GenerationMetrics) => {
      if (generationMetrics) {
        const key = generationMessageKey(message as unknown as AssistantMessage);
        if (key) recordedMetrics[key] = generationMetrics;
      }
      messages.push(message); streamingMessage = null; lastProgressAt = Date.now();
      send({ type: "message_end", message, ...(generationMetrics ? { generationMetrics } : {}) });
    };
    const server = createServer((_req, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": new URL(baseURL).origin,
      });
      response.write("retry: 60000\n\n"); streams.add(response);
      response.on("close", () => streams.delete(response));
      response.write(`data: ${JSON.stringify({ type: "connected", sessionId: SESSION })}\n\n`);
      response.write(`id: output-feedback:${sequence}\ndata: ${JSON.stringify(snapshot())}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const commands: Record<string, unknown>[] = [], forbidden: string[] = [];
    await page.route("**/api/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (["GET", "HEAD"].includes(req.method())) {
        if (path === `/api/agent/${SESSION}`) return route.fulfill({ json: { running: true, state: state() } });
        return route.continue();
      }
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (isFixtureReadReceipt(req)) return route.fulfill({ json: { scope: req.postDataJSON().scope, receipts: {} } });
      if (path === `/api/agent/${SESSION}`) {
        const command = req.postDataJSON();
        if (["get_tools", "abort", "steer"].includes(command?.type)) {
          commands.push(command);
          if (command.type === "steer") {
            queued = [...queued, { id: command.queueId, message: command.message, deliveryMode: "steer" }];
            send({ type: "queue_update", items: queued });
          }
          return route.fulfill({ json: { success: true, data: command.type === "get_tools" ? [] : null } });
        }
      }
      forbidden.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Offline fixture forbids inference and persistent mutations" } });
    });
    await page.route(/\/api\/models(?:\?|$)/, route => route.fulfill({ json: {
      modelList: [{ ...model, name: "Offline feedback model", available: true }],
      defaultModel: { provider: model.provider, modelId: model.id },
    } }));
    await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?|$)`), route => route.fulfill({
      json: { ...sessionData(), agentState: { running: true, state: state() } },
    }));
    await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.continue({ url: streamURL }));
    try {
      await provideFixture({
        commands,
        open: async () => {
          await page.goto(`/?session=${SESSION}`);
          await expect(page.getByTestId("run-monitor")).toHaveAttribute("data-run-phase", "thinking");
          await expect.poll(() => streams.size).toBe(1);
        },
        retry: () => {
          const failed = { ...assistant([]), stopReason: "error", errorMessage: "503 Service unavailable" };
          persist(failed);
          send({ type: "agent_end", willRetry: true, messages: [failed] });
          retry = { attempt: 1, maxAttempts: 3, retryAt: Date.now() + 60_000, errorMessage: failed.errorMessage };
          phase = { kind: "waiting_model" }; lastProgressAt = Date.now();
          send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 60_000, errorMessage: failed.errorMessage, runState: runState() });
        },
        continueAnswer: () => {
          persist({ ...assistant([{ type: "text", text: "Preserved partial answer." }]), stopReason: "length" });
          continuing = true; phase = { kind: "waiting_model" };
          send({ type: "turn_start", runState: runState() });
        },
        stop: () => {
          running = false; retry = null; streamingMessage = null; lastRunOutcome = "stopped";
          send({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
          // This is the wrapper's synthetic terminal event. Pi persists only
          // the earlier error when a user cancels during the backoff sleep.
          send({ type: "agent_end", runOutcome: "stopped", messages: [{ ...assistant([]), stopReason: "aborted" }] });
        },
        deliverSteering: () => {
          const item = queued[0]; if (!item) throw new Error("No steering queued");
          queued = queued.slice(1); send({ type: "queue_update", items: queued });
          const delivered = { role: "user", content: item.message, timestamp: Date.now() };
          send({ type: "message_start", message: delivered }); persist(delivered);
        },
        failTool: () => {
          const message = assistant([{ type: "toolCall", toolCallId: "offline-read", toolName: "read", input: { path: "fixture.ts" } }]);
          persist(message); phase = { kind: "running_tools", tools: [{ id: "offline-read", name: "read", startedAt: Date.now() }] };
          send({ type: "tool_execution_start", toolCallId: "offline-read", toolName: "read" });
          const result = { role: "toolResult", toolCallId: "offline-read", content: [{ type: "text", text: "Synthetic missing file" }], isError: true, timestamp: Date.now() };
          persist(result); send({ type: "tool_execution_end", toolCallId: "offline-read", toolName: "read", result });
          phase = { kind: "waiting_model" };
        },
        write: text => {
          const updating = phase.kind === "writing" && streamingMessage !== null;
          streamingMessage = updating ? { ...streamingMessage, content: [{ type: "text", text }] } : assistant([{ type: "text", text }]);
          phase = { kind: "writing" }; lastProgressAt = Date.now();
          if (!updating) send({ type: "message_start", message: streamingMessage });
          send({ type: "message_update", message: streamingMessage });
        },
        finish: () => {
          const final = streamingMessage ?? assistant([{ type: "text", text: "Finished the offline fixture." }]);
          // A short buffered callback still has a server-recorded average.
          persist(final, { tokens: 24, seconds: 0.4, estimated: false, source: "server", firstContentSeconds: 0.1 }); running = false; retry = null;
          send({ type: "agent_end", messages: [final] });
        },
        compact: () => {
          compaction = { id: "output-feedback-compact", status: "running", reason: "manual", startedAt: Date.now() - 5_000, revision: 1 };
          send({ type: "compaction_status", compaction: { ...compaction, observedAt: Date.now() } });
        },
        finishCompact: () => {
          if (!compaction) throw new Error("No active compaction");
          compaction = { ...compaction, status: "completed", revision: 2, result: { tokensBefore: 30_000, estimatedTokensAfter: 9_000 } };
          send({ type: "compaction_status", compaction: { ...compaction, observedAt: Date.now() } });
        },
      });
      expect(forbidden).toEqual([]);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
});

function seconds(label: string) {
  return Number(/(\d+)m/.exec(label)?.[1] ?? 0) * 60 + Number(/(\d+)s/.exec(label)?.[1] ?? 0);
}
async function retrySeconds(monitor: Locator) {
  return Number(/Retry 1\/3 in (\d+)s/.exec(await monitor.innerText())?.[1] ?? NaN);
}

for (const [label, width, height] of [["desktop", 1440, 960], ["mobile", 390, 850], ["narrow", 320, 740]] as const) {
  test(`${label}: live speed measures new text, expires when quiet, and persists a buffered average`, async ({ page, feedback }) => {
    await page.setViewportSize({ width, height }); await feedback.open();
    const monitor = page.getByTestId("run-monitor");
    const speed = page.getByRole("log", { name: "Conversation", exact: true }).getByTestId("streaming-speed");
    feedback.write("Starting visible output.");
    await expect(speed).toHaveAttribute("data-rate-available", "false");
    // Exercise the real 250 ms rolling sampler over an observation interval.
    let count = 1;
    await expect.poll(async () => {
      feedback.write("Visible output continues. ".repeat(++count));
      return speed.getAttribute("data-rate-available");
    }, { intervals: [550], timeout: 7000 }).toBe("true");
    await expect(speed).toContainText(/~ [\d.,]+ token\/s/);
    await expect(speed).toBeInViewport();
    const badge = speed.locator("[data-speed-tier]");
    await expect(badge).toBeVisible();
    const colours = await badge.evaluate(element => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, foreground: css.color, tier: element.getAttribute("data-speed-tier") };
    });
    const backgrounds = { slow: "rgb(224, 26, 79)", mid: "rgb(249, 194, 46)", good: "rgb(155, 197, 61)", fast: "rgb(83, 179, 203)" };
    expect(colours.background).toBe(backgrounds[colours.tier as keyof typeof backgrounds]);
    expect(colours.foreground).toBe(colours.tier === "slow" ? "rgb(255, 255, 255)" : "rgb(22, 22, 22)");

    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath(`live-speed-${label}.png`) });
    await expect(speed).toHaveAttribute("data-rate-available", "false", { timeout: 5000 });
    await expect(speed).toContainText("speed unavailable");
    feedback.failTool();
    await expect(speed).toHaveCount(0);
    feedback.write("A short buffered final answer."); feedback.finish();
    await expect(monitor).toHaveCount(0);
    const average = page.getByTestId("assistant-message-footer").getByTestId("completed-speed").last();
    await expect(average).toHaveText("24 tokens · avg 60 token/s");
    await expect(average).toHaveAttribute("data-metrics-source", "server");
    await expect(average.locator('[data-speed-tier="fast"]')).toHaveText("avg 60 token/s");
    await page.evaluate(() => localStorage.removeItem("pi-generation-metrics-v1"));
    await page.reload();
    await expect(average).toHaveText("24 tokens · avg 60 token/s");
    await expect(average).toBeInViewport();
    await expect(average.locator('[data-speed-tier="fast"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(feedback.commands.filter(command => command.type === "prompt")).toHaveLength(0);
  });

  test(`${label}: retry backoff survives reload and Stop has one honest terminal outcome`, async ({ page, feedback }) => {
    await page.setViewportSize({ width, height }); await feedback.open();
    const monitor = page.getByTestId("run-monitor"), elapsed = monitor.getByTestId("run-status-elapsed");
    const originalElapsed = seconds(await elapsed.innerText());
    expect(originalElapsed).toBeGreaterThanOrEqual(60);
    feedback.retry();
    await expect(monitor).toHaveAttribute("data-run-operation", "retry");
    await expect(monitor).toContainText(/Retry 1\/3 in \d+s/);
    await expect(page.locator('[data-retry-pending="true"]')).toHaveCount(1);
    await expect(page.getByRole("log", { name: "Conversation", exact: true }).getByRole("alert")).toHaveCount(0);
    expect(await page.title()).not.toMatch(/[✅⚠]/);
    const before = await retrySeconds(monitor);
    await expect.poll(() => retrySeconds(monitor)).toBeLessThan(before);
    await page.reload();
    await expect(monitor).toHaveAttribute("data-run-operation", "retry");
    await expect(monitor).toContainText(/Retry 1\/3 in \d+s/);
    expect(seconds(await elapsed.innerText())).toBeGreaterThanOrEqual(originalElapsed - 1);
    expect(await retrySeconds(monitor)).toBeLessThan(before);
    await expect(monitor).toBeInViewport();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath(`retry-backoff-${label}.png`) });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => feedback.commands.filter(command => command.type === "abort").length).toBe(1);
    await expect(monitor).toHaveAttribute("data-run-operation", "stopping");
    await expect(monitor).toContainText("Stopping");
    feedback.stop();
    await expect(monitor).toHaveCount(0);
    await expect(monitor.getByTestId("streaming-speed")).toHaveCount(0);
    await expect(page).toHaveTitle(/^⏹ /);
    await expect(page.locator('[data-stopped-attempt="true"]')).toContainText("Earlier attempt failed; the run was stopped");
    await expect(page.locator('[data-retry-pending="true"]')).toHaveCount(0);
    await expect(page.getByRole("log", { name: "Conversation", exact: true }).getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Assistant response complete", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Assistant response failed", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Rerun original request", exact: true })).toHaveCount(0);
    await page.getByText("Rerun this turn", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Rerun original request", exact: true })).toBeVisible();
    await expect(page.getByText("Sends the original request again. Completed actions are not undone and may run again.", { exact: true })).toBeVisible();
    expect(feedback.commands.filter(command => command.type === "prompt")).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath(`stopped-backoff-${label}.png`) });
  });

  test(`${label}: steering waits for SDK delivery, speed stays compact, and an answer records earlier tool failure`, async ({ page, feedback }) => {
    await page.setViewportSize({ width, height }); await feedback.open();
    const text = "Change direction after the current tool stage.";
    const input = page.locator("textarea").last();
    await page.getByRole("group", { name: "Message delivery mode" }).getByRole("button", { name: "Steer", exact: true }).click();
    await input.fill(text);
    await page.getByRole("button", { name: "Queue for the next model call (Option+Enter)", exact: true }).click();
    const queue = page.getByRole("region", { name: "Queued follow-ups", exact: true });
    const conversation = page.getByRole("log", { name: "Conversation", exact: true });
    await expect.poll(() => feedback.commands.filter(command => command.type === "steer").length).toBe(1);
    await expect(queue).toContainText("Steering queued"); await expect(queue).toContainText(text);
    await expect(queue).toContainText("Steering waits for the current tool stage");
    await expect(conversation.getByText(text, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(queue).toContainText(text);
    await expect(conversation.getByText(text, { exact: true })).toHaveCount(0);
    feedback.deliverSteering();
    await expect(queue).toHaveCount(0);
    await expect(conversation.getByText(text, { exact: true })).toHaveCount(1);
    await expect(conversation).not.toContainText("[steer]");
    feedback.failTool(); feedback.write("A visible answer is still available after the earlier file check failed.");
    const monitor = page.getByTestId("run-monitor");
    const speed = conversation.getByTestId("streaming-speed");
    await expect(speed).toContainText("speed unavailable");
    await expect(speed).toBeInViewport();
    await expect(monitor.getByTestId("streaming-speed")).toHaveCount(0);
    expect(await speed.evaluate(element => element.closest("details"))).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    feedback.finish();
    const work = page.locator('[data-work-log-state="issues"]');
    await expect(work).toHaveCount(1);
    await expect(work).toContainText("Answer received · Earlier failures: 1");
    await expect(work).not.toContainText("Needs attention");
    await expect(monitor).toHaveCount(0);
    const average = conversation.getByTestId("completed-speed").last();
    await expect(average).toHaveText("24 tokens · avg 60 token/s");
    await page.reload();
    await expect(monitor).toHaveCount(0);
    await expect(average).toHaveText("24 tokens · avg 60 token/s");
    expect(await average.evaluate(element => element.closest("details"))).toBeNull();
    await expect(conversation.getByTestId("generation-speed-details")).toHaveCount(0);
    expect(feedback.commands.filter(command => command.type === "prompt")).toHaveLength(0);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath(`steering-answer-${label}.png`) });
  });

  test(`${label}: output recovery stays pending through reload and quiets the earlier cap after completion`, async ({ page, feedback }) => {
    await page.setViewportSize({ width, height }); await feedback.open();
    feedback.continueAnswer();
    const monitor = page.getByTestId("run-monitor");
    await expect(monitor).toHaveAttribute("data-run-operation", "continuing");
    await expect(page.locator('[data-output-pending="true"]')).toHaveText("Continuing the answer");
    await expect(page.locator('[data-output-issue]')).toHaveCount(0);
    await page.reload();
    await expect(monitor).toHaveAttribute("data-run-operation", "continuing");
    await expect(page.getByText("Preserved partial answer.", { exact: true })).toBeVisible();
    await expect(page.locator('[data-output-pending="true"]')).toHaveText("Continuing the answer");
    await page.screenshot({ animations: "disabled", path: test.info().outputPath(`continuing-answer-${label}.png`) });
    feedback.write("The rest of the answer is complete."); feedback.finish();
    await expect(monitor).toHaveCount(0);
    await expect(page.getByTestId("assistant-message-footer").getByTestId("completed-speed").last()).toHaveText("24 tokens · avg 60 token/s");
    await expect(page.locator('[data-output-recovered="true"]')).toHaveCount(1);
    await expect(page.locator('[data-output-pending], [data-output-issue]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  test(`${label}: compaction owns its status while a model run is active, including after reload`, async ({ page, feedback }) => {
    await page.setViewportSize({ width, height }); await feedback.open();
    const monitor = page.getByTestId("run-monitor");
    const before = seconds(await monitor.getByTestId("run-status-elapsed").innerText());
    feedback.compact();
    const compact = page.getByTestId("compaction-status");
    await expect(compact).toHaveAttribute("data-state", "running");
    await expect(monitor).toHaveAttribute("data-run-phase", "compacting");
    await expect(page.getByTestId("streaming-speed")).toHaveAttribute("data-rate-available", "false");
    await expect(compact).toBeInViewport();
    await page.reload();
    await expect(compact).toHaveAttribute("data-state", "running");
    await expect(monitor).toHaveAttribute("data-run-phase", "compacting");
    await expect(page.getByTestId("streaming-speed")).toHaveAttribute("data-rate-available", "false");
    await expect(compact.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath(`compact-feedback-${label}.png`) });
    feedback.finishCompact();
    await expect(monitor).toHaveCount(1);
    expect(seconds(await monitor.getByTestId("run-status-elapsed").innerText())).toBeGreaterThanOrEqual(before - 1);
    expect(feedback.commands.filter(command => ["prompt", "compact"].includes(String(command.type)))).toHaveLength(0);
  });
}
