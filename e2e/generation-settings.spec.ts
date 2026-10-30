import { test as base, expect } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GenerationSettingsState } from "../lib/generation-settings";
import { withFixtureMessages } from "./session-response-fixture";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const PROVIDER = "live-settings-fixture";
const PARTIAL = "Existing partial answer must survive the settings change.";
type Fixture = { commands: Record<string, unknown>[]; next: () => void; tool: (running: boolean) => void };
const test = base.extend<{ settingsFlow: Fixture }>({
  settingsFlow: async ({ page, request, baseURL }, use) => {
    if (!baseURL || !process.env.E2E_ROOT || !process.env.E2E_PROJECT_CWD
      || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Isolated E2E fixtures required");
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-composer-hints", "off");
      localStorage.setItem("pi-theme", "dark"); localStorage.setItem("pi-ui-style", "original");
    });
    const response = await request.get(`/api/sessions/${SESSION}`, { headers: { "X-Pi-Session-Tree": "flat-v2" } });
    expect(response.ok()).toBe(true); const seed = await response.json(); await response.dispose();
    const startedAt = Date.now() - 20_000;
    let running = true, sequence = 0, tools = false;
    let settings: GenerationSettingsState = { selected: { provider: PROVIDER, modelId: "alpha", thinkingLevel: "low" },
      active: { provider: PROVIDER, modelId: "alpha", thinkingLevel: "low" }, revision: 0, pending: false,
      restarting: false, runId: "initial-live-settings-run", canRestart: true };
    const assistant = () => ({ role: "assistant", provider: PROVIDER, model: settings.active?.modelId ?? "alpha",
      timestamp: startedAt + 1_000, content: [{ type: "text", text: PARTIAL }], stopReason: "stop" });
    let streamingMessage: Record<string, unknown> | null = assistant();
    const messages: Record<string, unknown>[] = [{ role: "user", content: "Complete the existing task.", timestamp: startedAt }];
    const runState = () => ({ id: settings.runId, startedAt, lastProgressAt: Date.now(), observedAt: Date.now(),
      phase: tools ? { kind: "running_tools", tools: [{ id: "active-read", name: "read", startedAt }] } : { kind: "writing" } });
    const state = () => ({ isStreaming: running, model: { provider: PROVIDER, id: settings.selected!.modelId },
      thinkingLevel: settings.selected!.thinkingLevel, isCompacting: false, runState: running ? runState() : null,
      generationSettings: settings, queuedFollowUps: [], compactionQueue: [], autoCompactionEnabled: false });
    const data = () => {
      const d = withFixtureMessages(seed, messages, messages.map((_, i) => `settings-${i}`));
      return { ...d, context: { ...d.context, model: { provider: PROVIDER, modelId: settings.selected!.modelId }, thinkingLevel: settings.selected!.thinkingLevel } };
    };
    const snapshot = () => ({ type: "session_snapshot", sessionId: SESSION, state: state(), sessionData: data(), streamingMessage,
      phase: runState().phase, bashRun: null });
    const streams = new Set<ServerResponse>();
    const send = (event: Record<string, unknown>) => {
      const frame = `id: settings:${++sequence}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const stream of streams) stream.write(frame);
    };
    const publish = () => send({ type: "generation_settings_changed", settings });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": new URL(baseURL).origin });
      res.write("retry: 60000\n\n"); streams.add(res); res.on("close", () => streams.delete(res));
      res.write(`data: ${JSON.stringify({ type: "connected", sessionId: SESSION })}\n\n`);
      res.write(`id: settings:${sequence}\ndata: ${JSON.stringify(snapshot())}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const streamURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const commands: Record<string, unknown>[] = [], forbidden: string[] = [];
    await page.route("**/api/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (["GET", "HEAD"].includes(req.method())) {
        if (path === `/api/agent/${SESSION}/events`) return route.continue({ url: streamURL });
        if (path === `/api/agent/${SESSION}`) return route.fulfill({ json: { running: true, state: state() } });
        if (path === `/api/sessions/${SESSION}`) return route.fulfill({ json: { ...data(), agentState: { running: true, state: state() } } });
        if (path === "/api/models") return route.fulfill({ json: {
          modelList: ["alpha", "beta"].map(id => ({ id, provider: PROVIDER, name: `Fixture ${id}`, available: true })),
          defaultModel: { provider: PROVIDER, modelId: "alpha" },
          thinkingLevels: { [`${PROVIDER}:alpha`]: ["off", "low", "medium", "high"], [`${PROVIDER}:beta`]: ["off", "low", "medium", "high"] },
        } });
        return route.continue();
      }
      if (path === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
      if (path === `/api/agent/${SESSION}/summarize`) return route.fulfill({ json: { skipped: true } });
      if (isFixtureReadReceipt(req)) return route.fulfill({ json: { scope: req.postDataJSON().scope, receipts: {} } });
      if (path === `/api/agent/${SESSION}`) {
        const command = req.postDataJSON(); commands.push(command);
        if (command.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
        if (command.type === "configure_generation") {
          const selected = { ...settings.selected!, ...(command.model ?? {}),
            ...(command.thinkingLevel ? { thinkingLevel: command.thinkingLevel === "auto" ? "medium" : command.thinkingLevel } : {}) };
          settings = { ...settings, selected, revision: settings.revision + 1, pending: true }; publish();
          return route.fulfill({ json: { success: true, data: settings } });
        }
        if (command.type === "resume" && command.stopCurrentRun) {
          expect(command.expectedRunId).toBe(settings.runId); expect(command.expectedSettingsRevision).toBe(settings.revision);
          settings = { ...settings, restarting: true, canRestart: false }; publish();
          const final = { ...streamingMessage, stopReason: "aborted" }; messages.push(final); streamingMessage = null;
          send({ type: "message_end", message: final }); running = false;
          send({ type: "agent_end", messages: [final], runOutcome: "stopped", generationSettings: settings });
          settings = { ...settings, active: settings.selected, pending: false, restarting: false, runId: "continued-live-settings-run", canRestart: true };
          running = true; send({ type: "agent_start", runState: runState(), generationSettings: settings }); publish();
          return route.fulfill({ json: { success: true, data: { accepted: true } } });
        }
        if (command.type === "abort") {
          running = false; settings = { ...settings, pending: false, active: null, runId: null, canRestart: false };
          send({ type: "agent_end", messages: [], runOutcome: "stopped", generationSettings: settings });
          return route.fulfill({ json: { success: true, data: null } });
        }
      }
      forbidden.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Offline settings fixture forbids model and persistent mutations" } });
    });
    try {
      await use({ commands,
        next: () => { settings = { ...settings, active: settings.selected, pending: false }; publish(); },
        tool: active => {
          tools = active; settings = { ...settings, canRestart: !active }; publish();
          send(active ? { type: "tool_execution_start", toolCallId: "active-read", toolName: "read", args: { path: "fixture.txt" } }
            : { type: "tool_execution_end", toolCallId: "active-read", toolName: "read", result: { content: [{ type: "text", text: "saved" }] } });
        },
      });
      expect(forbidden).toEqual([]);
    } finally { await page.unrouteAll({ behavior: "wait" }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

for (const width of [320, 390, 1440]) {
  test(`${width}px: model and reasoning stay editable while streaming; defaults and next-request notice are accurate`, async ({ page, settingsFlow }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?session=${SESSION}`);
    const composer = page.getByRole("textbox", { name: "Message…", exact: true });
    await expect(page.getByTestId("run-monitor")).toBeVisible();
    await composer.fill("Saved unsent draft");
    const model = page.getByTestId("model-selector-trigger");
    await expect(model).toBeEnabled(); await model.click();
    await page.locator("[data-model-choice]").filter({ hasText: "Fixture beta" }).last().click();
    await expect(model).toContainText("Fixture beta");
    await expect(page.getByTestId("generation-settings-status")).toContainText("next model request");
    await expect(page.getByText(PARTIAL, { exact: true })).toBeAttached();
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    const reasoning = page.getByRole("button", { name: "Change reasoning level", exact: true });
    await expect(reasoning).toBeEnabled(); await reasoning.click();
    await page.getByRole("option", { name: /Model default/ }).click();
    await expect(reasoning).toHaveAttribute("title", "Reasoning: Medium");
    if (width < 701) await page.getByRole("button", { name: "Close", exact: true }).click();
    else await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Show activity details", exact: true }).click();
    await expect(page.getByTestId("generation-settings-current")).toContainText("alpha · low");
    await expect(page.getByTestId("generation-settings-selected")).toContainText("beta · medium");
    settingsFlow.tool(true);
    await expect(page.getByTestId("apply-generation-settings")).toBeDisabled();
    settingsFlow.tool(false); settingsFlow.next();
    await expect(page.getByTestId("generation-settings-status")).toHaveCount(0);
    await expect(page.getByTestId("generation-settings-current")).toContainText("beta · medium");
    await expect(composer).toHaveValue("Saved unsent draft");
    expect(settingsFlow.commands.filter(c => c.type === "configure_generation")).toHaveLength(2);
    expect(settingsFlow.commands.some(c => ["prompt", "resume", "abort"].includes(String(c.type)))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`${width}px: explicit stop and continue retains partial text and unsent draft, without resending the user prompt`, async ({ page, settingsFlow }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/?session=${SESSION}`);
    const composer = page.getByRole("textbox", { name: "Message…", exact: true }); await composer.fill("Keep this draft");
    await page.getByTestId("model-selector-trigger").click();
    await page.locator("[data-model-choice]").filter({ hasText: "Fixture beta" }).last().click();
    const apply = page.getByTestId("apply-generation-settings"); await expect(apply).toBeEnabled(); await apply.click();
    await expect(page.getByTestId("generation-settings-status")).toHaveCount(0);
    await expect(composer).toHaveValue("Keep this draft");
    await expect(page.getByText(PARTIAL, { exact: true })).toBeAttached();
    await expect(page.getByRole("group", { name: "Recovery options", exact: true })).toHaveCount(0);
    expect(settingsFlow.commands.filter(c => c.type === "resume")).toHaveLength(1);
    expect(settingsFlow.commands.some(c => ["prompt", "navigate_tree"].includes(String(c.type)))).toBe(false);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeInViewport();
  });
}
