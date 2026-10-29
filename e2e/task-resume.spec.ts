import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withFixtureMessages } from "./session-response-fixture";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const ORIGINAL = "Finish the saved fixture task without repeating completed actions.";
const PARTIAL = "Saved partial answer before interruption.";
const TOOL_RESULT = "SAVED_TOOL_RESULT_42: the read already completed.";
const DRAFT = "Keep this unsent draft exactly as written.";
const model = { provider: "task-resume-fixture", id: "offline" };
const assistant = (content: Record<string, unknown>[], stopReason = "stop") => ({
  role: "assistant", provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason,
});
type Outcome = "error" | "length" | "empty" | "aborted";
type ResumeFixture = {
  commands: Record<string, unknown>[];
  open: (outcome?: Outcome) => Promise<void>;
  write: (text: string) => void;
  finish: (text?: string) => void;
  allowExplicitRerun: () => void;
};

// Native loopback SSE exercises the real browser hook/reducer. Every write,
// including read receipts and rerun navigation, is fulfilled locally; unknown
// writes fail the test instead of reaching an agent or persistent fixture store.
const test = base.extend<{ recovery: ResumeFixture }>({
  recovery: async ({ page, baseURL, request }, provide) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)
      || !process.env.E2E_ROOT || !process.env.E2E_PROJECT_CWD) throw new Error("Isolated E2E fixture server required");
    await page.addInitScript(() => {
      localStorage.setItem("pi-composer-hints", "off"); localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-ui-style", "original"); localStorage.setItem("pi-theme", "dark");
      localStorage.setItem("pi-auto-provider-fallback", "0");
    });
    const seedResponse = await request.get(`/api/sessions/${SESSION}`, { headers: { "X-Pi-Session-Tree": "flat-v2" } });
    expect(seedResponse.ok()).toBe(true);
    const seed = await seedResponse.json(); await seedResponse.dispose();
    const startedAt = Date.now() - 20_000;
    let sequence = 0, running = false, explicitRerun = false, continuing = false, runStartedAt = Date.now();
    let lastRunOutcome: "stopped" | null = null;
    let phase: Record<string, unknown> = { kind: "waiting_model" };
    let streamingMessage: Record<string, unknown> | null = null;
    const messages: Record<string, unknown>[] = [
      { role: "user", content: "An earlier completed request.", timestamp: startedAt - 10_000 },
      { ...assistant([{ type: "text", text: "Earlier completed answer." }]), timestamp: startedAt - 9_000 },
      { role: "user", content: ORIGINAL, timestamp: startedAt },
      { ...assistant([{ type: "toolCall", toolCallId: "saved-read", toolName: "read", input: { path: "saved-fixture.txt" } }], "toolUse"), timestamp: startedAt + 1_000 },
      { role: "toolResult", toolCallId: "saved-read", toolName: "read", content: [{ type: "text", text: TOOL_RESULT }],
        isError: false, timestamp: startedAt + 2_000 },
      { ...assistant([{ type: "text", text: PARTIAL }], "error"), errorMessage: "Synthetic fixture failure", timestamp: startedAt + 3_000 },
    ];
    const entryIds = ["history-user", "history-answer", "task-user", "saved-tool-call", "saved-tool-result", "interrupted-answer"];
    const state = () => ({ isStreaming: running, model, thinkingLevel: "off", isCompacting: false,
      queuedFollowUps: [], compaction: null, compactionQueue: [], autoCompactionEnabled: false,
      runState: running ? { id: "manual-task-resume-run", startedAt: runStartedAt,
        lastProgressAt: Date.now(), observedAt: Date.now(), phase, ...(continuing ? { continuing: true } : {}) } : null,
    });
    const sessionData = () => {
      const data = withFixtureMessages(seed, messages, entryIds);
      return { ...data, context: { ...data.context, model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off" } };
    };
    const snapshot = () => ({ type: "session_snapshot", protocolVersion: 2, sessionId: SESSION,
      cursor: `task-resume:${sequence}`, state: state(), sessionData: sessionData(), streamingMessage,
      phase: running ? phase : null, bashRun: null, lastRunOutcome,
    });
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      const frame = `id: task-resume:${++sequence}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const stream of streams) stream.write(frame);
    };
    const begin = () => {
      running = true; continuing = false; lastRunOutcome = null; runStartedAt = Date.now(); phase = { kind: "waiting_model" };
      send({ type: "agent_start", runState: state().runState });
    };
    const finish = (text = "Finished using the saved work.", stopped = false) => {
      const final = streamingMessage ? { ...streamingMessage, stopReason: stopped ? "aborted" : "stop" }
        : assistant([{ type: "text", text }], stopped ? "aborted" : "stop");
      messages.push(final); entryIds.push(`resumed-answer-${messages.length}`); streamingMessage = null;
      send({ type: "message_end", message: final }); running = false; continuing = false; lastRunOutcome = stopped ? "stopped" : null;
      send({ type: "agent_end", messages: [final], ...(stopped ? { runOutcome: "stopped" } : {}) });
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": new URL(baseURL).origin });
      response.write("retry: 60000\n\n"); streams.add(response);
      response.on("close", () => streams.delete(response));
      response.write(`data: ${JSON.stringify({ type: "connected", sessionId: SESSION })}\n\n`);
      response.write(`id: task-resume:${sequence}\ndata: ${JSON.stringify(snapshot())}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const commands: Record<string, unknown>[] = [], forbidden: string[] = [];
    await page.route("**/api/**", async route => {
      const req = route.request(), url = new URL(req.url()), path = url.pathname;
      if (["GET", "HEAD"].includes(req.method())) {
        if (path === `/api/agent/${SESSION}/events`) return route.continue({ url: streamURL });
        if (path === `/api/agent/${SESSION}`) return route.fulfill({ json: { running: true, state: state() } });
        if (path === `/api/sessions/${SESSION}`) return route.fulfill({ json: {
          ...sessionData(), agentState: { running: true, state: state() },
        } });
        if (path === `/api/sessions/${SESSION}/context`) return route.fulfill({ json: { context: sessionData().context } });
        if (path === "/api/models") return route.fulfill({ json: {
          modelList: [{ ...model, name: "Offline recovery model", available: true }],
          defaultModel: { provider: model.provider, modelId: model.id },
        } });
        return route.continue();
      }
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (isFixtureReadReceipt(req)) return route.fulfill({ json: { scope: req.postDataJSON().scope, receipts: {} } });
      if (path === `/api/agent/${SESSION}`) {
        const command = req.postDataJSON(); commands.push(command);
        if (command.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
        if (command.type === "resume") {
          begin(); continuing = true;
          send({ type: "task_resume_started", runState: state().runState });
          return route.fulfill({ json: { success: true, data: { accepted: true } } });
        }
        if (command.type === "abort") {
          if (running) finish("Stopped after resuming the task.", true);
          return route.fulfill({ json: { success: true, data: null } });
        }
        if (explicitRerun && command.type === "navigate_tree") {
          const end = entryIds.indexOf(String(command.targetId));
          if (end < 0) throw new Error("Unknown fixture navigation target");
          messages.splice(end + 1); entryIds.splice(end + 1);
          return route.fulfill({ json: { success: true, data: { cancelled: false } } });
        }
        if (explicitRerun && command.type === "prompt") {
          messages.push({ role: "user", content: command.message, timestamp: Date.now() }); entryIds.push("explicit-rerun-user");
          begin(); return route.fulfill({ json: { success: true, data: null } });
        }
      }
      forbidden.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Offline fixture forbids agent and persistent mutations" } });
    });
    try {
      await provide({ commands,
        open: async (outcome = "error") => {
          if (outcome !== "error") {
            messages[5] = { ...assistant(outcome === "empty" ? [] : [{ type: "text", text: PARTIAL }],
              outcome === "empty" ? "stop" : outcome), timestamp: startedAt + 3_000 };
            lastRunOutcome = outcome === "aborted" ? "stopped" : null;
          }
          await page.goto(`/?session=${SESSION}`);
          await expect(page.getByRole("group", { name: "Recovery options", exact: true })).toBeVisible();
          await expect.poll(() => streams.size).toBe(1);
        },
        write: text => {
          streamingMessage = assistant([{ type: "text", text }]); phase = { kind: "writing" };
          send({ type: "message_start", message: streamingMessage }); send({ type: "message_update", message: streamingMessage });
        },
        finish: text => finish(text), allowExplicitRerun: () => { explicitRerun = true; },
      });
      expect(forbidden).toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
});

const recoveryGroup = (page: Page) =>
  page.getByRole("group", { name: "Recovery options", exact: true });
async function expectCollapsedRerun(group: Locator) {
  const details = group.locator("details");
  await expect(details).not.toHaveAttribute("open");
  await expect(details.locator("summary")).toHaveText("Rerun this turn");
  await expect(details.getByRole("button", { name: "Rerun original request", exact: true })).not.toBeVisible();
  await expect(group.getByText("Sends the original request again. Completed actions are not undone and may run again.", { exact: true })).not.toBeVisible();
}
function resumeCommands(fixture: ResumeFixture) { return fixture.commands.filter(command => command.type === "resume"); }
function expectResumeOnly(fixture: ResumeFixture) {
  expect(resumeCommands(fixture)).toHaveLength(1);
  expect(resumeCommands(fixture)[0]).toEqual({ type: "resume", requestId: expect.any(String), timingId: expect.any(String) });
  expect(resumeCommands(fixture)[0].message).toBeUndefined();
  expect(fixture.commands.filter(command => ["navigate_tree", "prompt", "steer", "follow_up"].includes(String(command.type)))).toHaveLength(0);
}

for (const [label, width, height] of [["desktop", 1440, 960], ["mobile", 390, 850]] as const) {
  test(`${label}: Resume keeps saved history, tool results and the draft, and admits one request under double activation`, async ({ page, recovery }) => {
    await page.setViewportSize({ width, height }); await recovery.open();
    const group = recoveryGroup(page), conversation = page.getByRole("log", { name: "Conversation", exact: true });
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    await input.fill(DRAFT); await expectCollapsedRerun(group);
    const userIds = await conversation.locator('[data-message-role="user"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-entry-id")));
    expect(userIds).toHaveLength(2);
    await expect(conversation.getByText(PARTIAL, { exact: true })).toBeVisible();
    const work = conversation.locator("[data-work-log-state]").last();
    await work.getByRole("button", { name: /^Work log/ }).click();
    const tool = work.locator('[data-tool-call-id="saved-read"]');
    await expect(tool).toHaveAttribute("data-tool-state", "success");
    await tool.getByRole("button").first().click(); await expect(tool).toContainText(TOOL_RESULT);
    await group.scrollIntoViewIfNeeded();
    await group.screenshot({ animations: "disabled", path: test.info().outputPath(`task-recovery-${label}.png`) });
    await group.getByRole("button", { name: "Resume task", exact: true }).evaluate(button => {
      (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
    });
    await expect.poll(() => resumeCommands(recovery).length).toBe(1);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.getByTestId("run-monitor")).toHaveAttribute("data-run-operation", "continuing");
    await expect(page.getByTestId("run-monitor")).toContainText("Continuing the answer");
    await expect(input).toHaveValue(DRAFT); await expect(conversation.getByText(PARTIAL, { exact: true })).toBeVisible();
    await expect(conversation.locator('[data-tool-call-id="saved-read"]')).toHaveCount(1);
    expect(await conversation.locator('[data-message-role="user"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-entry-id")))).toEqual(userIds);
    expectResumeOnly(recovery);
    recovery.write("Remaining answer from the preserved work."); recovery.finish();
    await expect(page.getByTestId("run-monitor")).toHaveCount(0);
    await expect(page.getByTestId("run-monitor").getByTestId("streaming-speed")).toHaveCount(0);
    await expect(conversation.getByText("Remaining answer from the preserved work.", { exact: true })).toBeVisible();
    await expect(conversation.getByText(ORIGINAL, { exact: true })).toHaveCount(1);
    await expect(input).toHaveValue(DRAFT);
    await page.reload(); await expect(input).toHaveValue(DRAFT);
    await expect(conversation.getByText(PARTIAL, { exact: true })).toBeVisible();
    expectResumeOnly(recovery);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

for (const [outcome, width] of [["empty", 1440], ["length", 390], ["aborted", 390]] as const) {
  test(`${width}px: ${outcome} exposes Resume as the primary action with explicit rerun initially closed`, async ({ page, recovery }) => {
    await page.setViewportSize({ width, height: 900 }); await recovery.open(outcome);
    const group = recoveryGroup(page);
    await expectCollapsedRerun(group);
    await expect(group.getByRole("button").first()).toHaveText("Resume task");
    await group.getByRole("button", { name: "Resume task", exact: true }).click();
    await expect.poll(() => resumeCommands(recovery).length).toBe(1); expectResumeOnly(recovery);
    recovery.finish();
    await expect(page.getByRole("log", { name: "Conversation", exact: true }).getByText("Finished using the saved work.", { exact: true })).toBeVisible();
    await expect(group).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

test("mobile: Stop after Resume preserves partial work and the draft", async ({ page, recovery }) => {
  await page.setViewportSize({ width: 390, height: 850 }); await recovery.open();
  const input = page.getByRole("textbox", { name: "Message…", exact: true }); await input.fill(DRAFT);
  await recoveryGroup(page).getByRole("button", { name: "Resume task", exact: true }).click();
  await expect.poll(() => resumeCommands(recovery).length).toBe(1);
  recovery.write("New visible progress before Stop.");
  await expect(page.getByRole("log", { name: "Conversation", exact: true }).getByText("New visible progress before Stop.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => recovery.commands.filter(command => command.type === "abort").length).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("run-monitor")).toHaveCount(0);
    await expect(page.getByTestId("run-monitor").getByTestId("streaming-speed")).toHaveCount(0);
  await expect(recoveryGroup(page).getByRole("button", { name: "Resume task", exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Conversation", exact: true }).getByText(PARTIAL, { exact: true })).toBeVisible();
  await expect(input).toHaveValue(DRAFT); expectResumeOnly(recovery);
  await expect(page).toHaveTitle(/^⏹ /);
});

test("desktop: opening rerun details is inert, and explicit rerun still resends the original turn", async ({ page, recovery }) => {
  await page.setViewportSize({ width: 1440, height: 960 }); await recovery.open(); recovery.allowExplicitRerun();
  const group = recoveryGroup(page); await expectCollapsedRerun(group);
  await group.locator("summary").click();
  await expect(group.locator("details")).toHaveAttribute("open", "");
  await expect(group.getByText("Sends the original request again. Completed actions are not undone and may run again.", { exact: true })).toBeVisible();
  expect(recovery.commands.filter(command => command.type !== "get_tools")).toHaveLength(0);
  await group.getByRole("button", { name: "Rerun original request", exact: true }).click();
  await expect.poll(() => recovery.commands.filter(command => command.type === "prompt").length).toBe(1);
  expect(recovery.commands.filter(command => command.type === "navigate_tree")).toMatchObject([{ targetId: "history-answer" }]);
  expect(recovery.commands.find(command => command.type === "prompt")?.message).toBe(ORIGINAL);
  expect(resumeCommands(recovery)).toHaveLength(0);
  recovery.finish("Finished the explicitly rerun turn.");
  await expect(page.getByRole("log", { name: "Conversation", exact: true }).getByText("Finished the explicitly rerun turn.", { exact: true })).toBeVisible();
});
