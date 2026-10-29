import { test, expect, type Page } from "@playwright/test";

const TGD = "/?session=dddd1111-2222-3333-4444-555566667777";
const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function expectNoProgressControls(page: Page) {
  await expect(page.locator('[class*="TgdPipeline_"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /(?:Show|Hide) the tGD pipeline/ })).toHaveCount(0);
  await expect(page.locator('button[title^="/tgd-"]')).toHaveCount(0);
}

test("existing history and project documents never trigger tGD progress inference", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
  const artifactRequests: string[] = [];
  page.on("request", req => {
    if (new URL(req.url()).pathname === "/api/tgd/artifacts") artifactRequests.push(req.url());
  });
  await page.goto(TGD);
  await expect(page.getByText("tGD 流程測試").first()).toBeVisible();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText("/tgd-map 理解這個專案", { exact: true })).toBeVisible();
  await expectNoProgressControls(page);
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible();
  await expectNoProgressControls(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
  await expectNoProgressControls(page);
  // A blank new conversation is not persisted. Reload the saved session to
  // exercise actual session restoration rather than the session picker.
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeEditable();
  await expectNoProgressControls(page);
  expect(artifactRequests).toEqual([]);
});

test("a real chat turn does not load tGD progress or add phase controls on mobile", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 950 });
  await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
  await page.route(/\/api\/agent\/[^/]+\/summarize$/, route => route.fulfill({ json: { skipped: true } }));
  const artifactRequests: string[] = [];
  page.on("request", req => {
    if (new URL(req.url()).pathname === "/api/tgd/artifacts") artifactRequests.push(req.url());
  });
  const created = await request.post("/api/agent/new", { data: {
    cwd: process.env.E2E_PROJECT_CWD!, deferPrompt: true, provider: "e2e-reconnect-fixture", modelId: "deterministic",
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const { sessionId } = await created.json();
  await page.goto(`/?session=${sessionId}`);
  const input = page.getByRole("textbox", { name: "Message…", exact: true });
  await expect(input).toBeEditable();
  await expectNoProgressControls(page);
  await input.fill("E2E_RECONNECT:complete:no-tgd-progress");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText("Fixture completed no-tgd-progress.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expectNoProgressControls(page);
  expect(artifactRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath("chat-without-tgd-progress.png") });
});
