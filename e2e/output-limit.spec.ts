import { isFixtureReadReceipt } from "./read-receipt-fixture";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { withFixtureMessages } from "./session-response-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const variants = [
  { name: "reasoning-only", stopReason: "length", content: [{ type: "thinking", thinking: "Synthetic reasoning" }], width: 320, issue: "output_limit", title: "Output limit reached" },
  { name: "partial", stopReason: "length", content: [{ type: "text", text: "Preserved partial answer" }], width: 390, issue: "output_limit", title: "Output limit reached" },
  { name: "empty", stopReason: "stop", content: [], width: 1440, issue: "empty_output", title: "No answer produced" },
];

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function installOutcome(page: Page, variant: typeof variants[number]) {
  const provider = "fixture", modelId = "fixture-reasoning";
  const final = { role: "assistant", provider, model: modelId, stopReason: variant.stopReason, content: variant.content, timestamp: 1_780_000_000_100 };
  const messages = [{ role: "user", content: "Answer the synthetic question", timestamp: 1_780_000_000_000 }, final];
  const commands: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    const body = request.postDataJSON();
    if (pathname === "/api/worktrees" && Array.isArray(body?.cwds) && Object.keys(body).length === 1) return route.continue();
    if (pathname.endsWith("/summarize")) return route.fulfill({ json: {} });
    if (pathname === `/api/agent/${SESSION}` && ["get_tools", "prompt"].includes(body?.type)) {
      commands.push(body);
      return route.fulfill({ json: { success: true, data: body.type === "get_tools" ? [] : null } });
    }
    if (isFixtureReadReceipt(request)) return route.continue();
    forbidden.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 403, json: { error: "Offline fixture forbids live model or persistent changes" } });
  });
  await page.route(/\/api\/models(?:\?|$)/, route => route.fulfill({ json: {
    modelList: [{ id: modelId, provider, name: "Fixture reasoning model", available: true }],
    defaultModel: { provider, modelId }, thinkingLevels: { [`${provider}:${modelId}`]: ["low", "medium", "high"] },
  } }));
  await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?includeState)?$`), async route => {
    const response = await route.fetch();
    const data = withFixtureMessages(await response.json(), messages, ["fixture-user", "fixture-outcome"]);
    await route.fulfill({ response, json: { ...data, context: { ...data.context, model: { provider, modelId }, thinkingLevel: "high" },
      agentState: { running: true, state: { isStreaming: false, thinkingLevel: "high", model: { provider, id: modelId } } },
    } });
  });
  await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => {
    const context = { messages, entryIds: ["fixture-user", "fixture-outcome"], model: { provider, modelId }, thinkingLevel: "high" };
    const events = [{ type: "connected", sessionId: SESSION },
      { type: "session_snapshot", sessionId: SESSION, sessionData: { sessionId: SESSION, tree: [], leafId: null, context }, state: { isStreaming: false, thinkingLevel: "high", model: { provider, id: modelId } } }];
    return route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\n${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}` });
  });
  return { commands, forbidden };
}

for (const style of ["original", "trae"]) for (const variant of variants) {
  test(`${style} ${variant.width}px: ${variant.name} has an honest outcome and one manual retry`, async ({ page }) => {
    test.setTimeout(25_000);
    await page.setViewportSize({ width: variant.width, height: 900 });
    await page.addInitScript(style => {
      localStorage.setItem("pi-composer-hints", "off"); localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-theme", style === "original" ? "dark" : "light");
    }, style);
    const fixture = await installOutcome(page, variant);
    await page.goto(`/?session=${SESSION}`);
    const alert = page.locator(`[data-output-issue="${variant.issue}"]`);
    await expect(alert).toHaveCount(1); await alert.scrollIntoViewIfNeeded(); await expect(alert).toBeVisible();
    await expect(alert).toContainText(variant.title);
    if (variant.name === "reasoning-only") await expect(alert).toContainText("before producing a visible answer");
    if (variant.name === "partial") await expect(page.getByText("Preserved partial answer", { exact: true })).toBeVisible();
    if (variant.name === "empty") await expect(alert).not.toContainText("Output limit reached");
    expect(await page.title()).not.toContain("✅");
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole("button", { name: "Adjust thinking", exact: true }).click();
    await expect(page.getByRole("button", { name: "Change reasoning level", exact: true })).toBeVisible();
    if (await page.getByRole("dialog").count()) {
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toBeVisible();
    await page.getByText("Rerun this turn", { exact: true }).click();
    const retry = page.getByRole("button", { name: "Rerun original request", exact: true });
    await retry.scrollIntoViewIfNeeded();
    await expect(page.getByText("Sends the original request again. Completed actions are not undone and may run again.", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`output-${style}-${variant.name}.png`) });
    await retry.click();
    await expect.poll(() => fixture.commands.filter(command => command.type === "prompt").length).toBe(1);
    expect(fixture.commands.find(command => command.type === "prompt")?.message).toBe("Answer the synthetic question");
    expect(fixture.forbidden).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`${width}px: real SDK automatically finishes an output-capped answer without another user message`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => { localStorage.setItem("pi-composer-hints", "off"); localStorage.setItem("pi-locale", "en"); });
    await page.route(/\/api\/agent\/[^/]+\/summarize$/, route => route.fulfill({ json: { skipped: true } }));
    const cwd = process.env.E2E_PROJECT_CWD!;
    const created = await request.post("/api/agent/new", { data: { cwd, deferPrompt: true, provider: "e2e-reconnect-fixture", modelId: "deterministic" } });
    expect(created.ok(), await created.text()).toBe(true);
    const { sessionId } = await created.json();
    await page.goto(`/?session=${sessionId}`);
    const prompt = `E2E_ANSWER_CAP:auto-${width}`;
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    await input.fill(prompt); await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Conversation" }).getByText(`ANSWER_COMPLETED:auto-${width}`, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-output-recovered="true"]')).toHaveCount(1);
    await expect(page.locator('[data-output-issue]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
    const persisted = await request.get(`/api/sessions/${sessionId}`);
    const { context } = await persisted.json();
    expect(context.messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(1);
    expect(context.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    writeFileSync(test.info().outputPath("automatic-answer-session.json"), JSON.stringify({ sessionId, agentDir: join(process.env.E2E_ROOT!, "agent"), width }));
  });
}
