import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "ffff1111-2222-3333-4444-555566667777";
const FILES = ["README.md", "data.json", "table.csv", "newfile.txt", "from-bash.txt", "成果 預覽.html"];

// Match file-browser-layout's read-only boundary, including its tightly
// constrained worktree lookup/read receipts. Add to composer must never send.
const test = base.extend<{ previewChromeSafety: void }>({
  previewChromeSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
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
      return route.fulfill({ status: 403, json: { error: "Preview chrome tests forbid model calls and mutations" } });
    });
    await use();
    expect(forbidden, "Preview controls must not send prompts or mutate fixture files/sessions").toEqual([]);
  }, { auto: true }],
});

async function settle(panel: Locator) {
  await panel.page().evaluate(() => document.fonts.ready);
  await expect.poll(() => panel.evaluate((element) => [element, ...element.parentElement!.children]
    .flatMap((node) => node.getAnimations({ subtree: true }))
    .some((animation) => animation instanceof CSSTransition && animation.playState === "running"))).toBe(false);
}

async function inside(control: Locator, container: Locator) {
  await expect(control).toBeVisible();
  await expect.poll(async () => {
    const [box, bounds] = await Promise.all([control.boundingBox(), container.boundingBox()]);
    return !!box && !!bounds && box.x >= bounds.x - 1 && box.y >= bounds.y - 1
      && box.x + box.width <= bounds.x + bounds.width + 1
      && box.y + box.height <= bounds.y + bounds.height + 1;
  }, { message: "File controls must remain fully visible within their row" }).toBe(true);
}

async function openFiles(page: Page) {
  const panel = page.locator(".right-panel-container");
  if ((await panel.getAttribute("class"))?.includes("right-panel-open")) {
    await panel.getByRole("button", { name: "Hide file panel", exact: true }).click();
    await expect(panel).toHaveClass(/right-panel-closed/);
  }
  await settle(panel);
  const sidebar = page.locator('.sidebar-container.sidebar-open[data-panel-view="files"]');
  if (await sidebar.count() === 0) await page.getByRole("button", { name: /^(Explorer|Files)$/ }).first().click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}

for (const style of ["original", "trae"] as const) for (const width of [320, 1440]) {
  test.describe(`${style} ${width}px preview chrome`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320, isMobile: width === 320 });

    test("keeps files switchable and HTML controls compact, focused, and read-only", async ({ page }) => {
      await page.addInitScript((style) => {
        if (window !== window.top) return;
        localStorage.setItem("pi-ui-style", style);
        localStorage.setItem("pi-locale", "en");
        localStorage.setItem("pi-right-width", "320");
        localStorage.setItem("pi-composer-hints", "off");
      }, style);
      await page.goto(`/?session=${SESSION}`);
      await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
      if (width === 320) expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const composer = page.getByRole("textbox", { name: "Message…", exact: true });
      const draft = `Keep this preview draft: ${style} ${width}`;
      await composer.fill(draft);
      await composer.blur();
      const panel = page.locator(".right-panel-container.right-panel-open");
      for (const file of FILES) {
        await test.step(`Open ${file} through Explorer`, async () => {
          const sidebar = await openFiles(page);
          await sidebar.getByRole("treeitem", { name: file, exact: true }).click();
          await expect(panel.getByRole("tab", { selected: true })).toContainText(file);
          await settle(panel);
        });
      }
      await settle(panel);

      const bar = panel.getByTestId("right-panel-tab-bar");
      const allFiles = bar.getByRole("button", { name: "Show all open files", exact: true });
      const layout = bar.getByRole("button", { name: "Panel layout", exact: true });
      const hide = bar.getByRole("button", { name: "Hide file panel", exact: true });
      for (const control of [allFiles, layout, hide]) await inside(control, bar);
      const review = bar.getByRole("button", { name: /\d+ to review/ });
      if (await review.count()) await inside(review, bar);
      else test.info().annotations.push({ type: "coverage-gap", description: "The passive review queue needs agent completion; this read-only fixture does not generate a pending-review badge." });

      // Real Explorer actions opened six existing files; switch to the first,
      // a middle file, and the last through the persistent all-files menu.
      for (const file of [FILES[0], FILES[2], FILES[5]]) {
        await allFiles.click();
        const menu = page.getByRole("menu", { name: "Show all open files", exact: true });
        await expect(menu.getByRole("menuitemradio")).toHaveCount(FILES.length);
        await menu.getByRole("menuitemradio").filter({ hasText: file }).click();
        await expect(menu).toBeHidden();
        const active = bar.getByRole("tab", { selected: true });
        await expect(active).toContainText(file);
        await inside(active, panel.getByTestId("file-tab-strip"));
        expect((await active.boundingBox())!.width).toBeGreaterThanOrEqual(width === 320 ? 44 : 24);
        await inside(allFiles, bar);
      }
      const rowControls = [bar.getByRole("tab", { selected: true }), allFiles, layout, hide];
      const rowTops = await Promise.all(rowControls.map(async (control) => (await control.boundingBox())!.y));
      expect(Math.max(...rowTops) - Math.min(...rowTops)).toBeLessThanOrEqual(4);
      await layout.press("Enter");
      const layoutMenu = page.getByRole("menu", { name: "Panel layout", exact: true });
      await expect(layoutMenu.getByRole("menuitem", { name: "Reset file panel width", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(layout).toBeFocused();

      const toolbar = panel.getByTestId("file-viewer-toolbar");
      const labels = ["Code", "Preview", "Isolated preview", "Reload preview", "Add to composer", "More file actions"];
      const controls = labels.map((name) => toolbar.getByRole("button", { name, exact: true }));
      for (const control of controls) await inside(control, toolbar);
      const tops = await Promise.all(controls.map(async (control) => (await control.boundingBox())!.y));
      expect(Math.max(...tops) - Math.min(...tops), "Default HTML actions share one row").toBeLessThanOrEqual(2);
      if (width === 320) for (const control of controls) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await expect(controls[1]).toHaveAttribute("aria-pressed", "true");
      const iframe = panel.locator('iframe[title="HTML preview"]');
      const heading = page.frameLocator('iframe[title="HTML preview"]').getByRole("heading", { name: "Linked HTML preview", exact: true });
      await expect(heading).toBeVisible();
      await expect(iframe.locator("..")).toHaveAttribute("aria-busy", "false");
      await settle(panel);
      const chromeHeight = (await iframe.boundingBox())!.y - (await panel.boundingBox())!.y;
      expect(chromeHeight).toBeGreaterThan(0);
      expect(chromeHeight).toBeLessThanOrEqual(width === 320 ? 160 : 128);

      const policy = controls[2];
      await policy.focus();
      await policy.press("Enter");
      const policyRegion = page.getByRole("region", { name: "Isolated preview", exact: true });
      await expect(policyRegion).toBeVisible();
      await expect(policyRegion).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(policyRegion).toBeHidden();
      await expect(policy).toBeFocused();

      const more = controls[5];
      await more.press("Enter");
      const moreMenu = page.getByRole("menu", { name: "More file actions", exact: true });
      await moreMenu.getByRole("menuitem", { name: "Info", exact: true }).focus();
      await page.keyboard.press("Enter");
      const info = page.getByRole("region", { name: "Info", exact: true });
      await expect(info).toBeVisible();
      await expect(info).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(info).toBeHidden();
      await expect(more).toBeFocused();

      const previousFrame = (await iframe.elementHandle())!;
      const reloaded = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET" && url.pathname.startsWith("/api/files/") && url.searchParams.get("type") === "html-preview";
      });
      await controls[3].click();
      expect((await reloaded).ok()).toBe(true);
      await expect.poll(() => previousFrame.evaluate((element) => element.isConnected)).toBe(false);
      await expect(heading).toBeVisible();
      await expect(iframe.locator("..")).toHaveAttribute("aria-busy", "false");
      await expect(composer).toHaveValue(draft);
      await controls[4].click();
      await expect(composer).toHaveValue(new RegExp(draft));
      await expect(composer).toHaveValue(/成果 預覽\.html/);
    });
  });
}
