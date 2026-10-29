import { isFixtureReadReceipt } from "./read-receipt-fixture";
import { expect, test, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
type Job = { id: string; status: string; reason: string; startedAt: number; revision?: number; retry?: { status: "waiting" | "retrying"; attempt: number; maxAttempts: number }; error?: string; notice?: string; result?: { tokensBefore: number; estimatedTokensAfter: number } };

async function enterMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: /^(Message…|Queue a message after compaction…)$/ });
  await input.fill(text);
  // Enter does not wait for React to finish committing the controlled draft,
  // unlike clicking Send. Wait for the same visible ready state first.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await input.press("Enter");
}

type PolicyFixture = { enabled: boolean; reserveTokens: number; keepRecentTokens: number; tokens: number; contextWindow: number };
async function fixture(page: Page, initialOutcome = "running", policy?: PolicyFixture) {
  let job: Job | null = null;
  let queue: object[] = [];
  const commands: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  const state = () => ({ isStreaming: false, isCompacting: job?.status === "running", compaction: job ? { ...job, observedAt: Date.now() } : null, compactionQueue: queue, thinkingLevel: "low",
    ...(policy ? { compactionSettings: { enabled: policy.enabled, reserveTokens: policy.reserveTokens, keepRecentTokens: policy.keepRecentTokens }, autoCompactionEnabled: policy.enabled,
      contextUsage: { tokens: policy.tokens, contextWindow: policy.contextWindow, percent: policy.tokens / policy.contextWindow * 100 } } : {}) });
  await page.route((url) => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === `/api/agent/${SESSION}`) return route.fulfill({ json: { running: true, state: state() } });
      return route.continue();
    }
    // Idle suggestions can run while a completed notice expires. Keep this
    // unrelated model request deterministic and inside the browser fixture.
    if (path === "/api/composer-hint") return route.fulfill({ json: { hint: null, status: "empty", retryable: false, retryAfterMs: 0 } });
    const command = request.postDataJSON();
    if (isFixtureReadReceipt(request)) return route.continue();
    if (path === "/api/worktrees" && Array.isArray(command?.cwds)) return route.continue();
    if (path.endsWith("/summarize")) return route.fulfill({ json: {} });
    if (path === `/api/agent/${SESSION}`) {
      commands.push(command);
      let data: unknown = null;
      if (command.type === "compact") { job = { id: command.requestId, status: initialOutcome, reason: "manual", startedAt: Date.now(), revision: 1, ...(initialOutcome === "skipped" ? { notice: "already_compacted" } : {}) }; data = job; }
      else if (command.type === "abort_compaction") { if (job) job = { ...job, status: "cancelled" }; }
      else if (command.type === "queue_compaction_prompt") { queue.push({ id: command.id, message: command.message }); data = { queued: true }; }
      else if (command.type === "clear_compaction_queue") queue = [];
      else if (command.type === "get_tools") data = [];
      else { forbidden.push(command.type); return route.fulfill({ status: 403, json: { error: "No real model calls allowed" } }); }
      return route.fulfill({ json: { success: true, data } });
    }
    forbidden.push(path);
    return route.fulfill({ status: 403, json: { error: "No persistent fixture changes allowed" } });
  });
  await page.route(/\/api\/models(?:\?|$)/, route => route.fulfill({ json: { modelList: [{ provider: "fixture", id: "model", name: "Fixture model", available: true }], defaultModel: { provider: "fixture", modelId: "model" } } }));
  // Fake compaction never changes the fixture JSONL. Capture the same flat-v2
  // transcript once, before navigation, so document reload/teardown cannot race
  // an upstream route.fetch() with a late fulfill of the original request.
  const sessionResponse = await page.request.get(`/api/sessions/${SESSION}`, { headers: { "X-Pi-Session-Tree": "flat-v2" } });
  expect(sessionResponse.status()).toBe(200);
  const sessionData = await sessionResponse.json();
  expect(sessionData.tree.format).toBe("flat-v2");
  await sessionResponse.dispose();
  await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?includeState)?$`), route => route.fulfill({
    json: { ...sessionData, context: { ...sessionData.context, model: { provider: "fixture", modelId: "model" } }, agentState: { running: true, state: state() } },
  }));
  await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\ndata: ${JSON.stringify({ type: "session_snapshot", sessionId: SESSION, state: state() })}\n\n` }));
  return { commands, forbidden, loseJob() { job = null; },
    retry(status: "waiting" | "retrying") { if (job) job = { ...job, revision: (job.revision ?? 0) + 1, retry: { status, attempt: 1, maxAttempts: 3 } }; },
    finish(status: string) { if (job) job = { ...job, status, retry: undefined, revision: (job.revision ?? 0) + 1, ...(status === "failed" ? { error: "429 rate limit; provider detail should stay collapsed" } : { result: { tokensBefore: 30000, estimatedTokensAfter: 9000 } }) }; } };
}

for (const style of ["original", "trae"]) for (const width of [320, 390, 1440, 1920]) {
  test(`${style} ${width}: compact stays inline, editable, cancellable and responsive`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ style, width }) => {
      localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", width === 320 ? "xlarge" : "default");
      localStorage.setItem("pi-chat-width", width === 1920 ? "wide" : "normal");
    }, { style, width });
    const backend = await fixture(page);
    await page.goto(`/?session=${SESSION}`);
    const input = page.getByRole("textbox", { name: /^(Message…|Queue a message after compaction…)$/ });
    await enterMessage(page, "/compact keep decisions");
    const status = page.getByTestId("compaction-status");
    await expect(status).toHaveAttribute("data-state", "running");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(input).toBeEditable();
    await expect(page.getByTestId("model-selector-trigger")).toBeDisabled();
    await enterMessage(page, "continue after compact");
    await expect(status).toContainText("1 message(s) waiting");
    await expect(input).toHaveValue("");
    await expect(status.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const panel = await status.boundingBox(); const editor = await input.boundingBox();
    const composer = await page.getByTestId("composer-toolbar").boundingBox();
    expect(Math.abs(panel!.x - composer!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel!.width - composer!.width)).toBeLessThanOrEqual(1);
    expect(panel!.width).toBeLessThanOrEqual(width === 1920 ? 1040 : 780);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(editor!.y + 2);
    await page.screenshot({ path: test.info().outputPath(`compact-${style}-${width}.png`) });
    await status.getByRole("button", { name: "Clear pending" }).click();
    await expect.poll(() => backend.commands.filter(command => command.type === "clear_compaction_queue").length).toBe(1);
    await expect(status).not.toContainText("message(s) waiting");
    await input.focus(); await input.press("Escape");
    await expect(status).toHaveAttribute("data-state", "cancelled");
    await expect(status).toContainText("Compaction stopped");
    expect(backend.commands.filter(command => command.type === "compact")).toHaveLength(1);
    expect(backend.forbidden).toEqual([]);
  });
}

test("resolved policy is user-opened while the warning follows the actual model threshold", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", "trae"); });
  const policy = { enabled: true, reserveTokens: 8_192, keepRecentTokens: 12_000, tokens: 80_000, contextWindow: 100_000 };
  const backend = await fixture(page, "running", policy);
  await page.goto(`/?session=${SESSION}`);
  const details = page.getByTestId("compaction-policy-details");
  const pressure = page.getByTestId("compaction-pressure");
  await expect(details).toHaveCount(0);
  await expect(pressure).toHaveCount(0);
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  await expect(details).toContainText("Auto above ≈91.8%");
  await expect(details).toContainText("91,808 context tokens");
  await expect(details).toContainText("Reserve 8,192 tokens; retain about 12,000 recent tokens");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).toHaveCount(0);
  policy.tokens = 91_809;
  await page.reload();
  await expect(pressure).toHaveAttribute("data-pressure", "true");
  const box = await pressure.boundingBox(); const composer = await page.getByTestId("composer-toolbar").boundingBox();
  expect(Math.abs(box!.x - composer!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - composer!.width)).toBeLessThanOrEqual(1);
  policy.enabled = false; policy.tokens = 99_000;
  await page.reload();
  await expect(pressure).toHaveCount(0);
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  await expect(details).toContainText("Auto off · manual compaction");
  await expect(details).toContainText("Automatic threshold and overflow compaction are disabled");
  await page.getByRole("dialog").getByRole("button", { name: "Compact", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("compaction-status")).toHaveAttribute("data-state", "running");
  expect(backend.commands.filter(command => command.type === "compact")).toHaveLength(1);
  expect(backend.forbidden).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("elapsed time and actual retry survive session switches and reload without restarting compact", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  const backend = await fixture(page);
  await page.goto(`/?session=${SESSION}`);
  await enterMessage(page, "/compact preserve context");
  const status = page.getByTestId("compaction-status");
  const elapsed = status.getByTestId("compaction-elapsed");
  await expect(status).toHaveAttribute("data-state", "running");
  await expect(elapsed).toHaveAttribute("aria-label", /^Elapsed /);
  await expect(elapsed).not.toHaveText("· 0s", { timeout: 5000 });
  backend.retry("waiting");
  await expect(status).toContainText("Waiting to retry (1/3)", { timeout: 6000 });
  await page.reload();
  await expect(status).toContainText("Waiting to retry (1/3)");
  await expect(elapsed).not.toHaveText("· 0s");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByText("專案架構分析", { exact: true }).first().click();
  await expect(status).toContainText("Waiting to retry (1/3)");
  await expect(elapsed).not.toHaveText("· 0s");
  backend.retry("retrying");
  await expect(status).toContainText("Retrying (1/3)", { timeout: 6000 });
  backend.finish("completed");
  await expect(status).toHaveAttribute("data-state", "completed", { timeout: 6000 });
  await expect(elapsed).toHaveCount(0);
  expect(backend.commands.filter(command => command.type === "compact")).toHaveLength(1);
  expect(backend.forbidden).toEqual([]);
});

test("no-op is neutral and failure details/retry are inline", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  const backend = await fixture(page, "skipped");
  await page.goto(`/?session=${SESSION}`);
  const input = page.getByRole("textbox", { name: /^(Message…|Queue a message after compaction…)$/ });
  await enterMessage(page, "/compact decisions");
  const status = page.getByTestId("compaction-status");
  await expect(status).toContainText("Already compacted");
  await expect(status.getByRole("alert")).toHaveCount(0);
  await status.getByRole("button", { name: "Dismiss compaction status" }).click();
  await expect(status).toHaveCount(0);
  // A new accepted operation fails later; polling reconciles it without a modal.
  await enterMessage(page, "/compact retry decisions");
  await expect(status).toHaveAttribute("data-state", "skipped");
  backend.finish("failed");
  await page.reload();
  await expect(status).toHaveAttribute("data-state", "failed");
  await expect(status.locator("details")).not.toHaveAttribute("open");
  await expect(status.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(input).toBeEditable();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(backend.forbidden).toEqual([]);
});

test("success expires once, survives reload, and a new compaction still announces its result", async ({ page }) => {
  const backend = await fixture(page, "completed");
  await page.goto(`/?session=${SESSION}`);
  await enterMessage(page, "/compact first result");
  const status = page.getByTestId("compaction-status");
  await expect(status).toHaveAttribute("data-state", "completed");
  await expect(status).toContainText("Context compacted");
  await expect(status).toHaveCount(0, { timeout: 8000 });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
  await expect(status).toHaveCount(0);
  await enterMessage(page, "/compact second result");
  await expect(status).toHaveAttribute("data-state", "completed");
  const requests = backend.commands.filter(command => command.type === "compact");
  expect(requests).toHaveLength(2);
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
  expect(backend.forbidden).toEqual([]);
});

for (const outcome of ["skipped", "cancelled"]) {
  test(`${outcome} expires and does not return after reload`, async ({ page }) => {
    const backend = await fixture(page, outcome);
    await page.goto(`/?session=${SESSION}`);
    await enterMessage(page, "/compact neutral result");
    const status = page.getByTestId("compaction-status");
    await expect(status).toHaveAttribute("data-state", outcome);
    await expect(status).toHaveCount(0, { timeout: 8000 });
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
    await expect(status).toHaveCount(0);
    expect(backend.commands.filter(command => command.type === "compact")).toHaveLength(1);
    expect(backend.forbidden).toEqual([]);
  });
}

test("lost operation stops processing without losing a draft or automatically retrying", async ({ page }) => {
  const backend = await fixture(page);
  await page.goto(`/?session=${SESSION}`);
  await enterMessage(page, "/compact keep decisions");
  const status = page.getByTestId("compaction-status");
  await expect(status).toHaveAttribute("data-state", "running");
  const input = page.getByRole("textbox", { name: "Message…", exact: true });
  await input.fill("unfinished draft");
  backend.loseJob();
  await expect(status).toHaveAttribute("data-state", "unknown", { timeout: 6000 });
  await expect(page.getByTestId("model-selector-trigger")).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toHaveValue("unfinished draft");
  await status.getByRole("button", { name: "Dismiss compaction status" }).click();
  await expect(status).toHaveCount(0);
  expect(backend.commands.filter(command => command.type === "compact")).toHaveLength(1);
  expect(backend.forbidden).toEqual([]);
});

for (const dismiss of [false, true]) {
  test(`success is not replayed after leaving the session (manually dismissed=${dismiss})`, async ({ page }) => {
    const backend = await fixture(page, "completed");
    await page.goto(`/?session=${SESSION}`);
    await enterMessage(page, "/compact result shown once");
    const status = page.getByTestId("compaction-status");
    await expect(status).toHaveAttribute("data-state", "completed");
    if (dismiss) {
      await status.getByRole("button", { name: "Dismiss compaction status" }).click();
      await expect(status).toHaveCount(0);
    }
    // Both leaving during the five-second display and explicitly dismissing
    // should acknowledge the result. Switch views without a document reload.
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`session=${SESSION}`));
    await page.getByText("專案架構分析", { exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`session=${SESSION}`));
    await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
    await expect(status).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
    await expect(status).toHaveCount(0);
    expect(backend.commands.filter(command => command.type === "compact")).toHaveLength(1);
    expect(backend.forbidden).toEqual([]);
  });
}
