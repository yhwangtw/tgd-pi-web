import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const SID = "aaaa1111-2222-3333-4444-555566667777";

async function preferences(page: Page, style = "trae", font = "default", locale = "zh", theme = "light") {
  await page.addInitScript(({ style, font, locale, theme }) => {
    if (window !== window.top) return;
    localStorage.setItem("pi-ui-style", style);
    localStorage.setItem("pi-skin", "trae");
    localStorage.setItem("pi-font-size", font);
    localStorage.setItem("pi-locale", locale);
    localStorage.setItem("pi-theme", theme);
  }, { style, font, locale, theme });
}

async function main(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("textbox", { name: "輸入訊息…" })).toBeVisible();
}

async function accessible(page: Page, rules: string[]) {
  const result = await new AxeBuilder({ page }).withRules(rules).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
}

for (const style of ["original", "trae"]) for (const width of [320, 390]) for (const font of ["default", "xlarge"]) {
  test(`${style} ${width}px ${font}: old message footer keeps its actions inside the screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await preferences(page, style, font);
    await main(page);
    await page.getByRole("button", { name: "對話", exact: true }).click();
    const footer = page.getByTestId("assistant-message-footer").last();
    await footer.scrollIntoViewIfNeeded();
    const more = footer.getByRole("button", { name: "更多訊息操作", exact: true });
    const bounds = await more.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    await more.click();
    const actions = footer.locator('details[open]');
    await expect(actions.getByRole("button", { name: "複製", exact: true })).toBeVisible();
    await actions.getByRole("button", { name: "引用", exact: true }).click();
    await expect(page.getByRole("button", { name: "移除引用", exact: true })).toBeVisible();
    await more.click();
    await expect(actions.getByRole("button", { name: /書籤/ })).toBeVisible();
  });
}

for (const style of ["original", "trae"]) {
  test(`${style}: wide code remains keyboard-scrollable on a 320px screen`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await preferences(page, style, "xlarge");
    await main(page);
    await page.getByRole("button", { name: "對話", exact: true }).click();
    const code = page.locator("pre").filter({ hasText: "API Layer → Service Layer → Data Layer" });
    await code.scrollIntoViewIfNeeded();
    expect(await code.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await code.focus();
    await expect(code).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => code.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await accessible(page, ["scrollable-region-focusable"]);
  });
}

test("Mermaid preview and code focus persist across parent updates while mathematics renders", async ({ page }) => {
  const root = process.env.E2E_PROJECT_CWD;
  if (!root) throw new Error("Generated E2E project is required");
  const readme = path.join(root, "README.md");
  const original = readFileSync(readme);
  try {
    writeFileSync(readme, original.toString() + '\n$$\\frac{a}{b}$$\n\n```mermaid\nflowchart LR\n A[Input] --> B[Render]\n```\n\n```ts\nconst value = 1;\n```\n');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await preferences(page);
    await main(page);
    await page.getByRole("button", { name: "檔案總管", exact: true }).click();
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "README.md", exact: true });
    await expect(panel.locator(".katex-display")).toBeVisible();
    await panel.getByTitle("預覽 Mermaid 圖表", { exact: true }).click();
    const diagram = panel.locator(".mermaid-block svg");
    await expect(diagram).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "搜尋", exact: true }).click();
    await page.setViewportSize({ width: 1430, height: 1000 });
    await expect(diagram).toBeVisible();
    await panel.getByRole("button", { name: "開啟專注模式", exact: true }).click();
    const focus = page.getByRole("dialog", { name: "ts", exact: true });
    await expect(focus).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(focus).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(focus).toHaveCount(0);
    await expect(diagram).toBeVisible();
  } finally {
    writeFileSync(readme, original);
  }
});

for (const style of ["original", "trae"]) {
  test(`${style}: file tabs support arrows, Home/End, panel relationships and keyboard close`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await preferences(page, style);
    await main(page);
    await page.getByRole("button", { name: "檔案總管", exact: true }).click();
    await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
    await page.getByRole("button", { name: "檔案總管", exact: true }).click();
    await page.getByRole("treeitem", { name: "data.json", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "已開啟的檔案" })).toBeAttached();
    const readme = page.getByRole("tab", { name: "README.md", exact: true });
    const data = page.getByRole("tab", { name: "data.json", exact: true });
    await data.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(readme).toBeFocused();
    await expect(readme).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel", { name: "README.md", exact: true });
    await expect(panel).toBeVisible();
    expect(await readme.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
    await page.keyboard.press("End");
    await expect(data).toBeFocused();
    await page.keyboard.press("Home");
    await expect(readme).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(data).toBeFocused();
    await accessible(page, ["aria-required-parent", "aria-required-children", "nested-interactive"]);
    await page.locator("[data-close-file-tab]").last().focus();
    await page.keyboard.press("Enter");
    await expect(data).toHaveCount(0);
    await expect(readme).toBeFocused();
  });
}

test("session grid keeps row selection and independent menus accessible, including no results", async ({ page }) => {
  await preferences(page);
  await main(page);
  const grid = page.getByRole("grid", { name: "對話紀錄", exact: true });
  await expect(grid).toBeVisible();
  await grid.focus();
  await page.keyboard.press("Home");
  await expect(grid.getByRole("row").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(grid.getByRole("row").last()).toBeFocused();
  const row = grid.locator(`[data-session-row="${SID}"]`);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await row.getByRole("button", { name: "更多操作" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row.getByRole("button", { name: "更多操作" })).toBeFocused();
  await accessible(page, ["aria-required-parent", "aria-required-children", "nested-interactive"]);
  await page.getByRole("textbox", { name: "搜尋對話", exact: true }).fill("no-matching-audit-session-xyzz");
  await expect(page.getByRole("status").filter({ hasText: "找不到符合" })).toBeVisible();
  await accessible(page, ["aria-required-parent", "aria-required-children", "nested-interactive"]);
});

for (const theme of ["light", "dark"]) test(`${theme}: custom provider fields and delete controls are accessible`, async ({ page }) => {
  await preferences(page, "trae", "default", "zh", theme);
  await page.route("**/api/provider-health", route => route.fulfill({ json: {
    checkedAt: "2026-10-09T00:00:00.000Z",
    summary: { ready: 0, needsAuth: 0, warning: 0, invalid: 0, total: 0 },
    coverage: { credentialReadiness: "checked", localCatalog: "checked", quotaAndBilling: "not_checked", upstreamAvailability: "not_checked" },
    providers: [],
  } }));
  await main(page);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const models = page.getByRole("dialog", { name: "模型", exact: true });
  await expect(models.getByTestId("provider-health").getByRole("button", { name: "新增 Provider", exact: true })).toBeVisible();
  await models.getByTestId("models-config-nav").getByRole("button", { name: "新增 Provider", exact: true }).click();
  await page.getByRole("button", { name: /OpenAI \/ Anthropic 相容端點/ }).click();
  await expect(models.getByRole("combobox", { name: "API", exact: true })).toBeVisible();
  await accessible(page, ["select-name", "label", "nested-interactive", "color-contrast"]);
});

test("mobile appearance returns keyboard focus to More after Escape and close button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preferences(page);
  await main(page);
  const more = page.getByRole("button", { name: "更多", exact: true });
  for (const closeWithEscape of [true, false]) {
    await more.click();
    await page.getByRole("button", { name: "外觀", exact: true }).click();
    const appearance = page.getByRole("dialog", { name: "外觀", exact: true });
    await expect(appearance).toBeVisible();
    if (closeWithEscape) await page.keyboard.press("Escape");
    else await appearance.getByRole("button", { name: "關閉外觀設定", exact: true }).click();
    await expect(appearance).toHaveCount(0);
    await expect(more).toBeFocused();
  }
});

for (const locale of ["zh", "en"]) {
  test(`direct login restores ${locale} language and a meaningful title`, async ({ page }) => {
    await preferences(page, "trae", "default", locale);
    await page.goto("/login");
    await expect(page.getByRole("textbox", { name: locale === "zh" ? "存取密碼" : "Access password" })).toBeVisible();
    await expect(page).toHaveTitle(locale === "zh" ? "解鎖 · Pi Web" : "Unlock · Pi Web");
    await expect(page.locator("html")).toHaveAttribute("lang", locale === "zh" ? "zh-Hant-TW" : "en");
    await accessible(page, ["document-title", "html-has-lang", "html-lang-valid"]);
  });
}

test("Chinese commands retain bilingual search and Chinese minimap labels", async ({ page }) => {
  await preferences(page);
  await main(page);
  await expect(page.getByRole("button", { name: /^跳到第 \d+ 則使用者訊息/ }).first()).toBeAttached();
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await page.getByRole("button", { name: "指令", exact: true }).click();
  const search = page.getByPlaceholder("搜尋 session、檔案、內容或指令…");
  await search.fill("models");
  await expect(page.getByText("開啟模型設定", { exact: true })).toBeVisible();
  await search.fill("模型");
  await expect(page.getByText("開啟模型設定", { exact: true })).toBeVisible();
});

for (const theme of ["light", "dark"]) {
  test(`${theme}: rendered chat badges, footer and primary controls meet text contrast`, async ({ page }) => {
    await preferences(page, "trae", "default", "zh", theme);
    const emptySessions = async (route: import("@playwright/test").Route) => route.fulfill({ json: { sessions: [] } });
    await page.route("**/api/sessions", emptySessions);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByRole("button", { name: "開始新對話", exact: true })).toBeVisible();
    await accessible(page, ["color-contrast"]);
    await page.unroute("**/api/sessions", emptySessions);
    await main(page);
    await accessible(page, ["color-contrast"]);
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await accessible(page, ["color-contrast"]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "背景任務", exact: true }).click();
    await expect(page.getByTestId("agent-new-run")).toBeVisible();
    await accessible(page, ["color-contrast"]);
    await page.getByRole("button", { name: "排程", exact: true }).click();
    await accessible(page, ["color-contrast"]);
    await page.getByRole("button", { name: "搜尋", exact: true }).click();
    await expect(page.getByPlaceholder("搜尋 session、檔案、內容或指令…")).toBeVisible();
    await accessible(page, ["color-contrast"]);
  });
}

test("three-pane header keeps the conversation button on one line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await preferences(page);
  await main(page);
  await page.getByRole("button", { name: "檔案總管", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await page.getByRole("button", { name: "搜尋", exact: true }).click();
  await expect(page.locator('.sidebar-open[data-panel-view="search"]')).toBeVisible();
  await expect(page.locator('.right-panel-container.right-panel-open')).toBeVisible();
  const button = page.locator('[class*="sessionMenuButton"]');
  const measure = await button.evaluate(el => {
    const label = el.querySelector("span")!;
    return { whiteSpace: getComputedStyle(el).whiteSpace, height: label.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(label).lineHeight), width: el.clientWidth, scroll: el.scrollWidth };
  });
  expect(measure.whiteSpace).toBe("nowrap");
  expect(measure.height).toBeLessThanOrEqual(measure.line + 1);
  expect(measure.scroll).toBeLessThanOrEqual(measure.width);
  await button.click();
  await expect(page.getByRole("menu")).toBeVisible();
});

test("desktop minimap keeps previews available on hover and keyboard focus", async ({ page }) => {
  await preferences(page);
  await main(page);
  const minimap = page.locator('[class*="ChatMinimap_container"]');
  await expect(minimap).toBeVisible();
  const layer = minimap.locator('[class*="tooltipLayer"]');
  await page.mouse.move(0, 0);
  await expect(layer).toBeHidden();
  await minimap.hover();
  await expect(layer).toBeVisible();
  await page.mouse.move(0, 0);
  const node = minimap.getByRole("button").first();
  await node.focus();
  await expect(minimap.locator('[class*="tooltipFocused"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-message").first()).toBeInViewport();
});

for (const width of [768, 840]) {
  test(`${width}px touch: minimap previews stay folded while jump controls work`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width, height: 1024 } });
    try {
      const page = await context.newPage();
      await preferences(page);
      await page.goto(`http://localhost:${process.env.E2E_PORT ?? 30177}${MAIN}`);
      await expect(page.getByRole("textbox", { name: "輸入訊息…" })).toBeVisible();
      const minimap = page.locator('[class*="ChatMinimap_container"]');
      await expect(minimap).toBeVisible();
      await expect(minimap.locator('[class*="tooltipLayer"]')).toBeHidden();
      const node = minimap.getByRole("button").first();
      await node.click();
      await expect(minimap.locator('[class*="tooltipLayer"]')).toBeHidden();
      await expect(page.getByTestId("user-message").first()).toBeInViewport();
    } finally { await context.close(); }
  });
}
