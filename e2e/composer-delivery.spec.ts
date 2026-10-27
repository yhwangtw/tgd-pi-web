import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = "aaaa1111-2222-3333-4444-555566667777";
const input = (page: Page) => page.getByTestId("composer-shell").locator("textarea");
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function create(page: Page) {
  const response = await page.request.post("/api/agent/new", { data: { cwd: process.env.E2E_PROJECT_CWD, deferPrompt: true, provider: "e2e-reconnect-fixture", modelId: "deterministic", toolNames: [] } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).sessionId as string;
}
test.beforeEach(async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) return route.abort();
    if (url.pathname.endsWith("/summarize")) return route.fulfill({ json: { skipped: true } });
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-composer-hints", "off"); localStorage.setItem("pi-ui-style", "original"); });
});

for (const width of [320, 390, 1440]) {
  test(`${width}px: delayed success and failure never hold or overwrite the next draft`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 950 });
    const id = await create(page); await page.goto(`/?session=${id}`);
    let hold = gate(); let calls = 0; let fail = false;
    await page.route(`**/api/agent/${id}`, async route => {
      if (route.request().method() !== "POST" || route.request().postDataJSON().type !== "prompt") return route.continue();
      calls++;
      if (fail) { await hold.promise; return route.fulfill({ status: 503, json: { error: "Fixture delivery unavailable" } }); }
      const response = await route.fetch(); await hold.promise; await route.fulfill({ response });
    });
    const first = `E2E_RECONNECT:complete:delivery-${width}`;
    await input(page).fill(first); await input(page).press("Enter");
    await expect(input(page)).toHaveValue(""); await expect(input(page)).toBeEditable();
    await input(page).fill("Next draft stays here"); await input(page).press("Enter");
    await expect.poll(() => calls).toBe(1); await expect(input(page)).toHaveValue("Next draft stays here");
    hold.release();
    await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(input(page)).toHaveValue("Next draft stays here");
    const transcript = await (await page.request.get(`/api/sessions/${id}/context`)).json();
    expect(transcript.context.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(1);
    hold = gate(); fail = true;
    await input(page).fill("Keep this failed message"); await input(page).press("Enter");
    await expect(input(page)).toHaveValue(""); await input(page).fill("A new draft"); hold.release();
    await expect(page.getByText("Message not sent · draft saved", { exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue("A new draft");
    await expect(page.getByRole("button", { name: "Add to draft", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`delivery-recovery-${width}.png`), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    await expect(input(page)).toHaveValue("A new draft\n\nKeep this failed message");
    fail = false; hold = gate(); hold.release();
    await input(page).fill(`E2E_RECONNECT:complete:edited-retry-${width}`); await input(page).press("Enter");
    await expect(page.getByRole("button", { name: "Discard saved message" })).toHaveCount(0);
    await expect(input(page)).toHaveValue("");
    writeFileSync(info.outputPath("composer-session.json"), JSON.stringify({ sessionId: id, agentDir: join(process.env.E2E_ROOT!, "agent"), width }));
  });
}

test("new conversation carries typing during first acknowledgement into its created session", async ({ page }) => {
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/projects/discover", route => route.fulfill({ json: { repos: [{ name: "Delivery fixture", path: process.env.E2E_PROJECT_CWD }] } }));
  // Select only the deterministic provider for this isolated conversation.
  await page.route(/\/api\/models(?:\?.*)?$/, async route => {
    const response = await route.fetch(); const body = await response.json();
    if (Array.isArray(body.modelList)) body.modelList = body.modelList.filter((m: { provider: string }) => m.provider === "e2e-reconnect-fixture");
    await route.fulfill({ response, json: body });
  });
  const hold = gate(); let createdId = "";
  await page.route("**/api/agent/new", async route => {
    const body = route.request().postDataJSON();
    const response = await route.fetch({ postData: { ...body, provider: "e2e-reconnect-fixture", modelId: "deterministic" } });
    createdId = (await response.json()).sessionId;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/agent\/[^/?]+$/, async route => {
    if (new URL(route.request().url()).pathname.endsWith("/new")) return route.fallback();
    if (route.request().method() === "POST" && route.request().postDataJSON().type === "prompt") { const response = await route.fetch(); await hold.promise; return route.fulfill({ response }); }
    return route.continue();
  });
  await page.goto("/"); await page.getByRole("button", { name: "Start a conversation", exact: true }).click();
  await page.getByTestId("project-switcher").getByRole("option", { name: /Delivery fixture/ }).click();
  await expect(page.getByRole("button", { name: /Model: E2E deterministic/ })).toBeVisible();
  await input(page).fill("E2E_RECONNECT:complete:first-ack"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input(page)).toHaveValue(""); await input(page).fill("Typed before session creation finished");
  await expect.poll(() => createdId).not.toBe(""); hold.release();
  await expect(page).toHaveURL(new RegExp(`session=${createdId}`));
  await expect(input(page)).toHaveValue("Typed before session creation finished");
});

test("switching sessions while a send fails preserves both drafts", async ({ page }) => {
  const id = await create(page); const hold = gate();
  const seed = await page.request.post(`/api/agent/${id}`, { data: { type: "prompt", message: "E2E_RECONNECT:complete:seed-switch" } });
  expect(seed.ok()).toBe(true);
  await page.goto(`/?session=${id}`);
  await expect(page.getByTestId("assistant-message").filter({ hasText: "Fixture completed seed-switch." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await page.route(`**/api/agent/${id}`, async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().type === "prompt") { await hold.promise; return route.fulfill({ status: 503, json: { error: "Fixture offline" } }); }
    return route.continue();
  });
  await input(page).fill("Original A"); await input(page).press("Enter"); await expect(input(page)).toHaveValue("");
  await page.locator(`[data-session-row="${FIXTURE}"]`).click(); await input(page).fill("Draft B"); hold.release();
  await expect(page).toHaveURL(new RegExp(`session=${FIXTURE}`)); await expect(input(page)).toHaveValue("Draft B");
  await page.locator(`[data-session-row="${id}"]`).click();
  await expect(page.getByText("Message not sent · draft saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore draft", exact: true }).click(); await expect(input(page)).toHaveValue("Original A");
});
