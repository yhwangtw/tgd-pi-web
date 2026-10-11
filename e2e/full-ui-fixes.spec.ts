import { expect, test, type Page } from "@playwright/test";
const PROVIDER = "e2e-reconnect-fixture";
const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local fixture required");
  const origin = new URL(baseURL).origin;
  await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", "original"); });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) return route.abort();
    if (url.pathname.endsWith("/summarize")) return route.fulfill({ json: { skipped: true } });
    return route.continue();
  });
});
async function create(page: Page, engine: "legacy" | "durable", toolNames: string[] = []) {
  const response = await page.request.post("/api/agent/new", { data: { cwd: process.env.E2E_PROJECT_CWD, engine, deferPrompt: true, provider: PROVIDER, modelId: "deterministic", type: "prompt", message: "", toolNames } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).sessionId as string;
}
for (const engine of ["legacy", "durable"] as const) test(`${engine}: queue edits, reorder, remove, clear and reconnect preserve the active reply`, async ({ page }, info) => {
  const id = await create(page, engine);
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await expect(input).toBeVisible();
  await input.fill(`E2E_RECONNECT:delayed:queue-fix-${engine}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress queue-fix-${engine}.` })).toBeVisible();
  const queue = page.getByRole("region", { name: "Queued follow-ups", exact: true });
  const add = async (token: string) => {
    await page.getByRole("group", { name: "Message delivery mode" }).getByRole("button", { name: "Follow-up", exact: true }).click();
    await input.fill(`E2E_RECONNECT:complete:${token}`);
    await page.getByRole("button", { name: "Queue until the current run finishes (Command+Enter)", exact: true }).click();
    await expect(queue).toContainText(token);
  };
  await add(`queue-first-${engine}`); await add(`queue-second-${engine}`);
  await queue.getByRole("button", { name: "Move earlier", exact: true }).nth(1).click();
  await expect(queue.locator("li").first()).toContainText(`queue-second-${engine}`);
  await queue.getByRole("button", { name: "Edit queued follow-up", exact: true }).first().click();
  await queue.getByRole("textbox", { name: "Edit queued follow-up" }).fill(`E2E_RECONNECT:complete:queue-edited-${engine}`);
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await expect(queue.locator("li").first()).toContainText(`queue-edited-${engine}`);
  await queue.getByRole("button", { name: "Remove queued follow-up", exact: true }).last().click();
  await expect(queue.locator("li")).toHaveCount(1);
  await queue.getByRole("button", { name: "Cancel all", exact: true }).click();
  await expect(queue).toHaveCount(0);
  await add(`queue-survivor-${engine}`);
  await page.reload();
  await expect(queue).toContainText(`queue-survivor-${engine}`);
  await page.screenshot({ path: info.outputPath(`queue-${engine}.png`) });
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed queue-survivor-${engine}.` })).toHaveCount(1, { timeout: 45_000 });
  await expect(queue).toHaveCount(0);
  const response = await page.request.get(`/api/sessions/${id}/context`);
  const data = await response.json();
  const text = JSON.stringify(data.context.messages);
  expect(text).not.toContain(`Fixture completed queue-first-${engine}.`);
  expect(text).not.toContain(`Fixture completed queue-edited-${engine}.`);
});

test("Stop during slow initial snapshot preserves the draft and never starts a prompt", async ({ page }) => {
  const id = await create(page, "legacy");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/agent/${id}/events*`, async route => { await gate; await route.continue(); });
  const prompts: unknown[] = [];
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === `/api/agent/${id}` && request.postDataJSON()?.type === "prompt") prompts.push(request.postDataJSON()); });
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await expect(input).toBeVisible();
  await input.fill("E2E_RECONNECT:complete:cancel-before-start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Connecting…", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(input).toHaveValue("E2E_RECONNECT:complete:cancel-before-start");
  release();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(prompts).toEqual([]);
});

test("Session menu supports keyboard movement, Escape and focus return", async ({ page }) => {
  await page.goto(MAIN);
  const trigger = page.getByRole("button", { name: "Session actions", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Large source stays bounded after loading more and line jumps", async ({ page }, info) => {
  await page.goto(MAIN);
  await page.getByRole("button", { name: /^(Explorer|Files)$/, exact: true }).first().click();
  await page.getByRole("treeitem", { name: "large-preview.txt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next lines", exact: true })).toBeVisible();
  expect(await page.locator("[data-line-number]").count()).toBeLessThanOrEqual(500);
  await page.getByRole("button", { name: "Next lines", exact: true }).click();
  await expect(page.locator('[data-line-number="501"]')).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText(/Loaded 512/)).toBeVisible();
  await page.locator("input[placeholder='find / :line']").fill(":15000");
  await expect(page.locator('[data-line-number="15000"][data-active-line]')).toBeVisible();
  expect(await page.locator("[data-line-number]").count()).toBeLessThanOrEqual(500);
  await page.screenshot({ path: info.outputPath("bounded-source.png") });
});

for (const width of [390, 1440]) test(`Original unread and mobile control sizes at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(MAIN);
  if (width === 390) await page.getByRole("button", { name: "Sessions", exact: true }).click();
  const unread = page.getByRole("button", { name: /^Unread \d+$/ });
  await expect(unread).toBeVisible();
  await unread.click();
  await expect(unread).toHaveAttribute("aria-pressed", "true");
  await unread.click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  if (width === 390) expect((await unread.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`original-${width}.png`) });
});

for (const partial of [false, true]) test(`Pi subagent ${partial ? "partial failure" : "parallel success"} reaches the transcript and work log`, async ({ page }) => {
  const id = await create(page, "legacy", ["subagent"]);
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await input.fill(`E2E_RECONNECT:subagents:${partial ? "partial" : "success"}-audit`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture delegation verified ${partial ? "partial" : "success"}-audit.` })).toBeVisible({ timeout: 30_000 });
  const response = await page.request.get(`/api/sessions/${id}/context`);
  const data = await response.json();
  const result = data.context.messages.find((message: { role: string; toolName?: string }) => message.role === "toolResult" && message.toolName === "subagent");
  expect(result.isError).toBe(partial);
  expect(result.details.runs.map((run: { status: string }) => run.status).sort()).toEqual(partial ? ["completed", "failed"] : ["completed", "completed"]);
  if (partial) await expect(page.getByRole("region", { name: "Work log", exact: true }).getByRole("button", { name: /Needs attention/ })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain("[object Object]");
  if (!partial) {
    const runs = await (await page.request.get("/api/agent-runs")).json();
    const children = runs.runs.filter((run: { id: string }) => result.details.runs.some((child: { runId: string }) => child.runId === run.id));
    expect(children).toHaveLength(2);
    expect(Math.max(...children.map((run: { startedAt: string }) => Date.parse(run.startedAt)))).toBeLessThan(Math.min(...children.map((run: { completedAt: string; finishedAt: string }) => Date.parse(run.completedAt ?? run.finishedAt))));
  }
});

test("Schedule delete confirmation has a cancel exit and resets on edit", async ({ page }) => {
  const schedule = { id: "cancel-only", name: "Disposable confirmation fixture", cwd: process.env.E2E_PROJECT_CWD,
    prompt: "Unused", timing: { kind: "daily", time: "09:00" }, timezone: "Asia/Taipei", enabled: false,
    missedRunPolicy: "skip", toolNames: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextRunAt: null };
  await page.route("**/api/schedules", route => route.fulfill({ json: { schedules: [schedule], runs: [], serverTime: new Date().toISOString() } }));
  const mutations: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/schedules/") && request.method() !== "GET") mutations.push(request.method()); });
  await page.goto(MAIN);
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  const card = page.getByTestId("schedule-panel").getByRole("article").filter({ hasText: schedule.name });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toContainText(`Delete this schedule? · ${schedule.name}`);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await card.getByRole("button", { name: "Edit schedule", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit schedule", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

for (const engine of ["legacy", "durable"] as const) test(`${engine}: Steer remains usable during a reply`, async ({ page }) => {
  const id = await create(page, engine);
  await page.goto(`/?session=${id}`);
  const input = page.locator("textarea").last();
  await input.fill(`E2E_RECONNECT:delayed:steer-before-${engine}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture progress steer-before-${engine}.` })).toBeVisible();
  await page.getByRole("group", { name: "Message delivery mode" }).getByRole("button", { name: "Steer", exact: true }).click();
  await input.fill(`E2E_RECONNECT:complete:steer-after-${engine}`);
  await page.getByRole("button", { name: "Interrupt the current run and inject now (Option+Enter)", exact: true }).click();
  await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed steer-after-${engine}.` })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

for (const width of [390, 1440]) test(`${width}: selected file actions are visible, keyboard usable and stay inside the viewport`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(MAIN);
  const files = page.getByRole("button", { name: /^(Explorer|Files)$/ }).first();
  await files.click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await expect(page.locator(".right-panel-container.right-panel-open")).toBeVisible();
  const trigger = page.getByRole("button", { name: "More file actions: README.md", exact: true });
  // Opening a file intentionally collapses the sidebar below 1600px.
  await expect(page.locator(".sidebar-container")).not.toHaveClass(/sidebar-open/);
  await files.click();
  await expect(trigger).toBeVisible();
  const input = page.locator("textarea").last();
  const draft = await input.inputValue();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  const rect = (await menu.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(844);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue(draft);
  if (width > 700) {
    await trigger.hover();
    const mention = page.getByRole("button", { name: "Insert @ mention: README.md", exact: true });
    await expect(mention).toBeVisible();
    const moreRect = (await trigger.boundingBox())!;
    const mentionRect = (await mention.boundingBox())!;
    expect(moreRect.x + moreRect.width).toBeLessThanOrEqual(mentionRect.x);
    await mention.click();
    await expect(input).toHaveValue(/README\.md/);
  }
});
