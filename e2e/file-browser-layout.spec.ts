import { isFixtureReadReceipt } from "./read-receipt-fixture";
import { expect, test as base, type Locator, type Page } from "@playwright/test";

const SESSION = "ffff1111-2222-3333-4444-555566667777";

// These layout checks read generated fixture files; they never invoke a model,
// save a file, or start the Inspector's real diagnostics/test commands.
const test = base.extend<{ fileLayoutSafety: void }>({
  fileLayoutSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
    await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/files/insights") return route.fulfill({ json: { diagnostics: [], commits: [], lines: [], matches: [] } });
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      let body: Record<string, unknown> | undefined;
      try { body = request.postDataJSON(); } catch { /* Deny other mutations. */ }
      if (request.method() === "POST" && pathname === "/api/worktrees" && body
        && Object.keys(body).length === 1 && Array.isArray(body.cwds)
        && body.cwds.length <= 128 && body.cwds.every((cwd) => typeof cwd === "string" && cwd.length > 0)) return route.continue();
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools") {
        return route.fulfill({ json: { success: true, data: [] } });
      }
      if (isFixtureReadReceipt(request)) return route.continue();
      forbidden.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: "File layout tests forbid model calls and mutations" } });
    });
    await use();
    expect(forbidden, "Browsing files must not execute models or mutate fixture files/sessions").toEqual([]);
  }, { auto: true }],
});

async function openFixture(page: Page, style: string, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((style) => {
    if (window !== window.top) return;
    localStorage.setItem("pi-ui-style", style);
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-right-width", "320");
  }, style);
  await page.goto(`/?session=${SESSION}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
}

async function openSource(page: Page) {
  await page.getByRole("link", { name: "查看程式", exact: true }).click();
  const panel = page.locator(".right-panel-open");
  await expect(panel.getByTestId("file-viewer-toolbar")).toBeVisible();
  await expect.poll(() => panel.evaluate((element) => [element, ...element.parentElement!.children]
    .flatMap((node) => node.getAnimations()).some((animation) => animation instanceof CSSTransition && animation.playState === "running"))).toBe(false);
  return panel;
}

async function withinViewport(page: Page, element: Locator) {
  await expect(element).toBeVisible();
  await expect.poll(async () => {
    const box = await element.boundingBox();
    const viewport = page.viewportSize()!;
    return !!box && box.x >= -1 && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1;
  }, { message: "File controls must fit inside the visible viewport" }).toBe(true);
}

for (const style of ["original", "trae"] as const) {
  for (const width of [320, 390]) {
    test(`${style} ${width}px: Inspector fills the workspace width and line navigation reveals the source`, async ({ page }) => {
      await openFixture(page, style, width, 800);
      const panel = await openSource(page);
      const trigger = panel.getByRole("button", { name: "Inspector", exact: true });
      await trigger.click();
      const inspector = page.getByTestId("file-inspector");
      await withinViewport(page, inspector);
      const workspace = inspector.locator("..");
      const workspaceBox = (await workspace.boundingBox())!;
      const box = (await inspector.boundingBox())!;
      expect(Math.abs(box.x - workspaceBox.x), "Mobile Inspector starts at the file workspace edge").toBeLessThanOrEqual(2);
      expect(Math.abs(box.width - workspaceBox.width), "Mobile Inspector is a full-width bottom sheet").toBeLessThanOrEqual(2);
      expect(Math.abs(box.y + box.height - workspaceBox.y - workspaceBox.height)).toBeLessThanOrEqual(2);
      expect(box.height, "Inspector leaves some source visible above the sheet").toBeLessThan(workspaceBox.height * 0.85);
      if (width === 390) await page.screenshot({ path: test.info().outputPath(`file-inspector-mobile-${style}.png`) });
      await inspector.getByRole("button", { name: /answer.*L1/ }).click();
      await expect(inspector).toBeHidden();
      await expect(panel.locator('[data-active-line][data-line-number="1"]')).toBeInViewport();
      await trigger.click();
      await inspector.getByRole("button", { name: "Close inspector", exact: true }).click();
      await expect(inspector).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  }

  test(`${style}: a 320px desktop panel stacks split files into readable full-width panes`, async ({ page }) => {
    await openFixture(page, style, 1440);
    await page.getByRole("link", { name: "查看成果", exact: true }).click();
    const panel = await openSource(page);
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(320);
    const htmlTab = panel.getByRole("tab", { name: /成果 預覽\.html/ });
    await htmlTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in split", exact: true }).click();
    const split = panel.getByTestId("file-split-pane");
    await expect(split).toBeVisible();
    const first = split.locator("..").locator(":scope > div").first();
    const firstBox = (await first.boundingBox())!;
    const secondBox = (await split.boundingBox())!;
    expect(firstBox.width).toBeGreaterThan(300);
    expect(secondBox.width).toBeGreaterThan(300);
    expect(Math.abs(firstBox.x - secondBox.x)).toBeLessThanOrEqual(2);
    expect(secondBox.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height - 2);
    await expect(split.locator('iframe[title="HTML preview"]')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`file-split-narrow-${style}.png`) });
    await panel.getByRole("button", { name: "Expand file panel", exact: true }).click();
    await expect.poll(async () => {
      const primary = await first.boundingBox();
      const secondary = await split.boundingBox();
      return !!primary && !!secondary && primary.width > 600 && secondary.width > 600
        && Math.abs(primary.y - secondary.y) <= 2
        && secondary.x >= primary.x + primary.width - 2;
    }, { message: "An expanded workspace can show both files side by side again" }).toBe(true);
    await panel.getByRole("button", { name: "Restore file panel", exact: true }).click();
    await expect.poll(async () => {
      const primary = await first.boundingBox();
      const secondary = await split.boundingBox();
      return !!primary && !!secondary && primary.width > 300 && secondary.width > 300
        && Math.abs(primary.x - secondary.x) <= 2
        && secondary.y >= primary.y + primary.height - 2;
    }).toBe(true);
  });

  test(`${style}: tab context menu stays inside the right edge and Escape restores tab focus`, async ({ page }) => {
    await openFixture(page, style, 1440, 600);
    await page.getByRole("link", { name: "查看成果", exact: true }).click();
    const panel = await openSource(page);
    const sourceTab = panel.getByRole("tab", { name: /index\.ts/ });
    await sourceTab.scrollIntoViewIfNeeded();
    await sourceTab.focus();
    const box = (await sourceTab.boundingBox())!;
    await sourceTab.click({ button: "right", position: { x: box.width - 5, y: box.height / 2 } });
    const menu = page.getByRole("menu");
    await withinViewport(page, menu);
    await expect(menu.locator('[role="menuitem"]:not(:disabled)').first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator('[role="menuitem"]:not(:disabled)').nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(sourceTab).toBeFocused();
  });

  test(`${style}: Info remains accessible in a short phone viewport`, async ({ page }) => {
    await openFixture(page, style, 390, 800);
    const panel = await openSource(page);
    await page.setViewportSize({ width: 390, height: 320 });
    const summary = panel.locator("summary").filter({ hasText: "Info" });
    await summary.click();
    const popover = page.getByRole("region", { name: "Info", exact: true });
    await withinViewport(page, popover);
    await expect(popover.getByText("Sync", { exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`file-info-short-${style}.png`) });
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(summary).toBeFocused();
  });

  test(`${style}: file browsing preserves chat space across laptop and wide desktop sizes`, async ({ page }) => {
    await openFixture(page, style, 1440);
    const panel = await openSource(page);
    const sidebar = page.locator(".sidebar-container");
    const center = page.getByTestId("top-bar").locator("..");
    await expect(sidebar).toHaveClass(/sidebar-closed/);
    for (const width of [1600, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await sidebar.getAttribute("class"))?.includes("sidebar-open")) await page.keyboard.press("ControlOrMeta+b");
      await expect(sidebar).toHaveClass(/sidebar-open/);
      await withinViewport(page, panel);
      await expect.poll(async () => (await center.boundingBox())!.width).toBeGreaterThanOrEqual(420);
    }
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(sidebar).toHaveClass(/sidebar-closed/);
    await withinViewport(page, panel);
    await expect.poll(async () => (await center.boundingBox())!.width).toBeGreaterThanOrEqual(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`file-browser-laptop-${style}.png`) });
  });

  test(`${style}: closing the file panel removes its controls from keyboard focus`, async ({ page }) => {
    await openFixture(page, style, 1440);
    const panel = await openSource(page);
    await panel.getByRole("button", { name: /^(Hide file panel|Back to chat)$/ }).click();
    await expect(page.locator(".right-panel-open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show file panel", exact: true })).toBeFocused();
    const hiddenPanel = page.locator(".right-panel-container");
    const canFocusHidden = await hiddenPanel.evaluate((element) => {
      for (const control of element.querySelectorAll<HTMLElement>("button, input, summary, [tabindex='0']")) {
        control.focus();
        if (element.contains(document.activeElement)) return true;
      }
      return false;
    });
    expect(canFocusHidden, "Closed file browser controls must be inert/unmounted").toBe(false);
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    await expect(page.locator(".right-panel-open").getByTestId("file-viewer-toolbar")).toBeVisible();
  });
}
