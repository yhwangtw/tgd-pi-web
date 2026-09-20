import { expect, test, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
type Job = { id: string; status: string; reason: string; startedAt: number; error?: string; notice?: string; result?: { tokensBefore: number; estimatedTokensAfter: number } };

async function enterMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: /^(Message…|Queue a message after compaction…)$/ });
  await input.fill(text);
  // Enter does not wait for React to finish committing the controlled draft,
  // unlike clicking Send. Wait for the same visible ready state first.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await input.press("Enter");
}

async function fixture(page: Page, initialOutcome = "running") {
  let job: Job | null = null;
  let queue: object[] = [];
  const commands: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  const state = () => ({ isStreaming: false, isCompacting: job?.status === "running", compaction: job, compactionQueue: queue, thinkingLevel: "low" });
  await page.route((url) => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === `/api/agent/${SESSION}`) return route.fulfill({ json: { running: true, state: state() } });
      return route.continue();
    }
    const command = request.postDataJSON();
    if (path === "/api/worktrees" && Array.isArray(command?.cwds)) return route.continue();
    if (path.endsWith("/summarize")) return route.fulfill({ json: {} });
    if (path === `/api/agent/${SESSION}`) {
      commands.push(command);
      let data: unknown = null;
      if (command.type === "compact") { job = { id: command.requestId, status: initialOutcome, reason: "manual", startedAt: Date.now(), ...(initialOutcome === "skipped" ? { notice: "already_compacted" } : {}) }; data = job; }
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
  await page.route(new RegExp(`/api/sessions/${SESSION}(?:\\?includeState)?$`), async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ response, json: { ...data, context: { ...data.context, model: { provider: "fixture", modelId: "model" } }, agentState: { running: true, state: state() } } });
  });
  await page.route(new RegExp(`/api/agent/${SESSION}/events(?:\\?|$)`), route => route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\ndata: ${JSON.stringify({ type: "session_snapshot", sessionId: SESSION, state: state() })}\n\n` }));
  return { commands, forbidden, finish(status: string) { if (job) job = { ...job, status, ...(status === "failed" ? { error: "429 rate limit; provider detail should stay collapsed" } : { result: { tokensBefore: 30000, estimatedTokensAfter: 9000 } }) }; } };
}

for (const style of ["original", "trae"]) for (const width of [320, 390, 1440]) {
  test(`${style} ${width}: compact stays inline, editable, cancellable and responsive`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ style, width }) => {
      localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", width === 320 ? "xlarge" : "default");
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
