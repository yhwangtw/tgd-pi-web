import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
async function open(page: Page, width = 921, style = "trae") {
  await page.addInitScript(style => {
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-ui-style", style);
    localStorage.setItem("pi-skin", "terminal");
    localStorage.setItem("pi-theme", "light");
  }, style);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(MAIN);
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
}

for (const style of ["original", "trae"]) {
  test(`${style}: expanded desktop settings keep the draft and real Send reachable`, async ({ page }, info) => {
    await page.route("**/api/agent/*/summarize", route => route.fulfill({ json: { skipped: true } }));
    await open(page, 921, style);
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    const token = `audit-composer-${style}`;
    await input.fill(`/e2e-reconnect-complete ${token}`);
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    const settings = page.getByRole("region", { name: "Composer controls", exact: true });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const [panelBox, inputBox, sendBox] = await Promise.all([settings.boundingBox(), input.boundingBox(), send.boundingBox()]);
    expect(panelBox).not.toBeNull(); expect(inputBox).not.toBeNull(); expect(sendBox).not.toBeNull();
    expect(panelBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
    expect(panelBox!.y).toBeGreaterThanOrEqual(sendBox!.y + sendBox!.height);
    await page.screenshot({ path: info.outputPath(`composer-${style}-921.png`) });
    await send.click();
    await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed ${token}.` })).toHaveCount(1);
  });
}

test("an unchanged session search discovers new history, renames in place and New resets the tab title", async ({ page }, info) => {
  await open(page);
  const query = "Audit search freshness";
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill(query);
  await expect(page.getByText("No matching conversations", { exact: true })).toBeVisible();
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const folder = join(process.env.PI_E2E_RUN_ROOT!, "agent", "sessions", "--audit-fixes--");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${id}.jsonl`);
  writeFileSync(file, [
    { type: "session", version: 3, id, cwd: process.env.E2E_PROJECT_CWD!, timestamp },
    { type: "session_info", id: "name", parentId: null, name: query, timestamp },
    { type: "message", id: "user", parentId: "name", timestamp, message: { role: "user", content: "Audit fixture", timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  try {
    const row = page.locator(`[data-session-row="${id}"]`);
    await expect(row).toBeVisible({ timeout: 12_000 });
    await row.click();
    await expect(page.getByTestId("top-bar")).toContainText(query);
    await row.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await row.getByRole("textbox").fill(`${query} renamed`);
    await row.getByRole("textbox").press("Enter");
    await expect(page.getByTestId("top-bar")).toContainText(`${query} renamed`);
    await expect(page).toHaveTitle(`${query} renamed — π with tGD`);
    await page.screenshot({ path: info.outputPath("search-and-title.png") });
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page).toHaveTitle("π with tGD");
  } finally { unlinkSync(file); }
});

test("sidebar Refresh forces the active search even when the session list has not changed", async ({ page }) => {
  let hits: unknown[] = [];
  await page.route("**/api/sessions/search?**", route => route.fulfill({ json: { hits } }));
  await open(page);
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("Indexed later");
  await expect(page.getByText("No matching conversations", { exact: true })).toBeVisible();
  hits = [{ id: "aaaa1111-2222-3333-4444-555566667777", name: "Indexed later", cwd: process.env.E2E_PROJECT_CWD!, firstMessage: "Indexed later", modified: new Date().toISOString(), messageCount: 8, score: 1, matchedIn: "name", matches: [] }];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('[data-session-row="aaaa1111-2222-3333-4444-555566667777"]')).toBeVisible();
});

for (const width of [390, 921, 1440]) {
  test(`${width}: Ask Pi reveals and focuses the draft with one confirmation`, async ({ page }, info) => {
    await open(page, width);
    await page.getByRole("button", { name: width < 700 ? "Files" : "Explorer", exact: true }).click();
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
    const panel = page.locator(".right-panel-container");
    await panel.getByRole("button", { name: "Ask Pi", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    await expect(input).toHaveValue(/README\.md/);
    await expect(input).toBeFocused();
    if (width <= 1024) await expect(panel).toHaveClass(/right-panel-closed/);
    else await expect(panel).toHaveClass(/right-panel-open/);
    await expect(page.getByText("Added file context to the composer", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Added file to the prompt", { exact: true })).toHaveCount(0);
    if (width < 700) {
      await expect.poll(() => page.locator(".sidebar-container").evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    await input.click();
    await expect(input).toBeFocused();
    await page.screenshot({ path: info.outputPath(`ask-pi-${width}.png`) });
  });
}

test("mobile Controls close icon stays readable in every palette and light/dark mode", async ({ page }, info) => {
  await open(page, 390);
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  const done = page.getByRole("dialog", { name: "Composer controls", exact: true }).getByRole("button", { name: "Close", exact: true });
  // Measure settled colors, including translucent control surfaces.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  const contrast = [];
  for (const skin of ["terminal", "trae", "editorial", "glass", "aurora", "industrial"]) for (const dark of [false, true]) {
    await page.locator("html").evaluate((element, { skin, dark }) => {
      element.setAttribute("data-skin", skin);
      element.classList.toggle("dark", dark);
    }, { skin, dark });
    const ratio = await done.evaluate(element => {
      // Browser-normalize CSS Color 4 color(srgb ...) as well as rgb/rgba.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const parse = (value: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const blend = (front: number[], back: number[]) => front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3]));
      const ancestors: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
      let background = [255, 255, 255];
      for (const node of ancestors) background = blend(parse(getComputedStyle(node).backgroundColor), background);
      const foreground = blend(parse(getComputedStyle(element).color), background);
      const luminance = (rgb: number[]) => rgb.map(value => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }).reduce((total, value, i) => total + value * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    contrast.push({ skin, dark, ratio });
    expect(ratio, `${skin} ${dark ? "dark" : "light"}`).toBeGreaterThanOrEqual(3);
  }
  await page.locator("html").evaluate(element => { element.setAttribute("data-skin", "terminal"); element.classList.remove("dark"); });
  await page.screenshot({ path: info.outputPath("mobile-close.png") });
  await info.attach("contrast.json", { body: JSON.stringify(contrast, null, 2), contentType: "application/json" });
  await done.click();
  await expect(page.getByRole("dialog", { name: "Composer controls", exact: true })).toBeHidden();
});

test("run filters explain no matches and analytics names its all-project scope", async ({ page }, info) => {
  await page.route("**/api/agent-runs?**", route => route.fulfill({ json: {
    runs: [{ id: "audit-done", name: "Completed audit fixture", cwd: process.env.E2E_PROJECT_CWD!, prompt: "Audit", status: "completed", createdAt: new Date().toISOString() }], maxConcurrency: 3,
  } }));
  await open(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const dashboard = page.getByTestId("agent-dashboard");
  await expect(dashboard.getByText("Completed audit fixture", { exact: true })).toBeVisible();
  await dashboard.getByRole("button", { name: "0 Active", exact: true }).click();
  await expect(dashboard.getByText("No matching runs", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("No background runs yet", { exact: true })).toHaveCount(0);
  await dashboard.getByRole("button", { name: "Clear filters", exact: true }).filter({ hasText: "Clear filters" }).click();
  await expect(dashboard.getByText("Completed audit fixture", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Token usage and cost report", exact: true }).first().click();
  const analytics = page.getByRole("dialog", { name: "Usage analytics", exact: true });
  await expect(analytics).toBeVisible();
  await expect(analytics).toContainText("Recorded usage across all projects");
  await page.screenshot({ path: info.outputPath("usage-scope.png") });
});
