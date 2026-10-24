import { expect, test, type Page } from "@playwright/test";

const SESSION = "ffff1111-2222-3333-4444-555566667777";
async function session(page: Page) {
  await page.goto(`/?session=${SESSION}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
}
async function fits(page: Page) {
  const panel = page.locator(".right-panel-open");
  await expect.poll(() => panel.evaluate(element => [element, ...element.parentElement!.children]
    .flatMap(node => node.getAnimations()).some(animation => animation instanceof CSSTransition && animation.playState === "running"))).toBe(false);
  const box = (await panel.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  const content = (await panel.locator('[class*="rightPanelContent"]').boundingBox())!;
  expect(content.x + content.width).toBeLessThanOrEqual(box.x + box.width + 1);
  await expect(panel.getByRole("button", { name: /^(Hide file panel|Back to chat)$/ })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

for (const style of ["original", "trae"]) {
  test(`${style}: mouse, keyboard, shrink, sidebar, expand, reset and reopen keep the preview usable`, async ({ page }) => {
    await page.addInitScript(style => {
      if (window !== window.top) return;
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-locale", "en");
    }, style);
    await page.setViewportSize({ width: 1440, height: 900 });
    await session(page);
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    await input.fill("Preserve the preview draft");
    await page.getByRole("link", { name: "查看成果", exact: true }).click();
    const panel = page.locator(".right-panel-open");
    await fits(page); // Opening animates the pane and its drag handle.
    const separator = panel.getByRole("separator", { name: "Resize file panel" });
    const edge = (await separator.boundingBox())!;
    const before = (await panel.boundingBox())!.width;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 150);
    await page.mouse.down();
    await expect(panel).toHaveClass(/right-panel-dragging/);
    await page.mouse.move(edge.x - 140, edge.y + 150, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 100);
    const preferred = await page.evaluate(() => localStorage.getItem("pi-right-width"));
    await separator.focus(); await separator.press("ArrowRight");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-right-width"))).not.toBe(preferred);
    await page.setViewportSize({ width: 768, height: 720 });
    await fits(page);
    const frameBox = (await panel.locator('iframe[title="HTML preview"]').boundingBox())!;
    expect(frameBox.width).toBeLessThanOrEqual((await panel.boundingBox())!.width);
    await panel.getByRole("button", { name: "Expand file panel", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Restore file panel", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(730);
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("button", { name: "Expand file panel", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Reset file panel width", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("pi-right-width"))).toBeNull();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: /^(Explorer|Files)$/ }).first().click();
    await fits(page);
    await panel.getByRole("button", { name: /^(Hide file panel|Back to chat)$/ }).click();
    await expect(input).toHaveValue("Preserve the preview draft");
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    await expect(panel.locator('iframe[title="HTML preview"]')).toBeVisible();
    await fits(page);
    // The existing file Focus mode owns Escape before the expanded outer pane.
    await panel.getByRole("button", { name: "Expand file panel", exact: true }).click();
    await panel.getByRole("button", { name: "More file actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Focus mode", exact: true }).click();
    await expect(page.locator('[data-file-focus-mode="true"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-file-focus-mode="true"]')).toBeHidden();
    await expect(panel.getByRole("button", { name: "Restore file panel", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("button", { name: "Expand file panel", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`preview-desktop-${style}.png`) });
  });

  test(`${style}: HTML preview fits phones, tablet breakpoints and short viewports`, async ({ browser, request, baseURL }) => {
    test.setTimeout(120_000);
    // Exercise the extension status/widgets that exist in a real live session,
    // including when this spec runs alone rather than after other UI workflows.
    const activation = await request.post(`/api/agent/${SESSION}`, { data: { type: "get_state" } });
    expect(activation.ok()).toBe(true);
    const context = await browser.newContext({ hasTouch: true, baseURL });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(style => { if (window === window.top) { localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-locale", "en"); } }, style);
    for (const width of [320, 390, 700, 701, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 700 ? 430 : 800 });
      await session(page);
      const transcript = page.locator("[data-transcript-scroll]");
      expect(await transcript.evaluate(element => element.clientHeight), "The composer must leave a usable transcript viewport").toBeGreaterThanOrEqual(44);
      await page.getByRole("link", { name: "查看成果", exact: true }).tap();
      const panel = page.locator(".right-panel-open");
      await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole("heading", { name: "Linked HTML preview" })).toBeVisible();
      await fits(page);
      const frame = (await panel.locator('iframe[title="HTML preview"]').boundingBox())!;
      expect(frame.height).toBeGreaterThan(80);
      expect(frame.y + frame.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      const controls = panel.locator('[class*="HtmlPreview_toolbar"] button');
      for (const control of await controls.all()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if ([390, 768, 1440].includes(width)) await page.screenshot({ path: test.info().outputPath(`preview-${width}-${style}.png`) });
      await panel.getByRole("button", { name: /^(Hide file panel|Back to chat)$/ }).tap();
      await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  test(`${style}: synthesized tablet touch resize survives cancel and a second finger`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ hasTouch: true, baseURL, viewport: { width: 820, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(style => { if (window === window.top) { localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-locale", "en"); } }, style);
    await session(page);
    await page.getByRole("link", { name: "查看成果", exact: true }).tap();
    const panel = page.locator(".right-panel-open");
    const separator = panel.getByRole("separator", { name: "Resize file panel" });
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(320);
    const client = await context.newCDPSession(page);
    const touch = async (type: string, points: { x: number; y: number; id: number }[]) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    for (const interrupt of ["cancel", "second finger", "commit"]) {
      const edge = (await separator.boundingBox())!;
      expect(edge.width).toBeGreaterThanOrEqual(24);
      const start = { x: edge.x + 12, y: edge.y + 160, id: 1 };
      const moved = { ...start, x: start.x - 70 };
      const before = (await panel.boundingBox())!.width;
      await touch("touchStart", [start]);
      await touch("touchMove", [moved]);
      await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 35);
      if (interrupt === "cancel") await touch("touchCancel", []);
      else if (interrupt === "second finger") {
        await touch("touchStart", [moved, { ...moved, x: moved.x + 80, id: 2 }]);
        await touch("touchEnd", []);
      } else await touch("touchEnd", []);
      await expect(panel).not.toHaveClass(/right-panel-dragging/);
      if (interrupt !== "commit") {
        await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(Math.round(before));
        expect(await page.evaluate(() => localStorage.getItem("pi-right-width"))).toBeNull();
      } else expect(Number(await page.evaluate(() => localStorage.getItem("pi-right-width")))).toBeGreaterThan(before + 35);
    }
    await fits(page);
    await context.close();
  });
}
