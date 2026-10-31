import { expect, test } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

for (const style of ["original", "trae"]) for (const width of [320, 390, 1440]) {
  test(`${style} ${width}: review updates never steal the file panel`, async ({ page }, info) => {
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-locale", "en");
    }, style);
    // Only the generated offline provider may run; auto-naming is unnecessary.
    await page.route("**/api/agent/*/summarize", route => route.fulfill({ json: { skipped: true } }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(MAIN);
    const composer = page.getByTestId("composer-shell").locator("textarea");
    await expect(composer).toBeVisible();
    await page.getByRole("button", { name: width < 700 ? "Files" : "Explorer", exact: true }).click();
    await page.getByRole("treeitem", { name: "big-file.ts", exact: true }).click();
    const panel = page.locator(".right-panel-container");
    const active = panel.getByRole("tab", { selected: true });
    const content = panel.locator('[class*="TextFileViewer_contentArea"]');
    await expect(active).toContainText("big-file.ts");
    await expect(panel.getByText("large-file mode")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await panel.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
    });
    const savedScrollTop = await content.evaluate(element => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 640 }));
      element.scrollTop = Math.min(640, Math.floor((element.scrollHeight - element.clientHeight) / 2));
      element.dispatchEvent(new Event("scroll"));
      return element.scrollTop;
    });
    expect(savedScrollTop).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-file-workspace-v1")!).tabs.find((tab: { label: string }) => tab.label === "big-file.ts").viewState?.scrollTop)).toBe(savedScrollTop);

    async function complete(token: string) {
      const reviewResponse = page.waitForResponse(response => response.url().includes("/api/git/changes?") && response.ok());
      await composer.fill(`/e2e-reconnect-complete ${token}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("assistant-message").filter({ hasText: `Fixture completed ${token}.` })).toHaveCount(1);
      await reviewResponse;
      await expect(page.getByTestId("file-review-count")).toBeAttached();
    }

    if (width > 700) {
      await complete(`${style}-open-review`);
      await expect(active).toContainText("big-file.ts");
      await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(savedScrollTop);
    }

    await page.getByTestId(width < 700 ? "right-panel-tab-bar" : "top-bar").getByRole("button", { name: /^(Hide file panel|Back to chat)$/ }).click();
    await expect(panel).toHaveClass(/right-panel-closed/);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-file-workspace-v1")!).open)).toBe(false);
    await page.reload();
    await expect(composer).toBeVisible();
    await expect(panel).toHaveClass(/right-panel-closed/);
    await complete(`${style}-${width}-closed-review`);
    await expect(panel).toHaveClass(/right-panel-closed/);
    expect(await page.getByText(/changed files are ready to review/).count()).toBe(0);

    // Opening the panel is explicit and preserves the old file and position.
    if (width < 700) await page.getByRole("button", { name: "Session actions", exact: true }).click();
    await page.getByRole("button", { name: "Show file panel", exact: true }).click();
    await expect(active).toContainText("big-file.ts");
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(savedScrollTop);
    const review = panel.getByRole("button", { name: /\d+ to review/ });
    await expect(review).toBeVisible();
    await expect.poll(() => panel.evaluate(element => [element, ...element.parentElement!.children]
      .flatMap(node => node.getAnimations()).some(animation => animation instanceof CSSTransition && animation.playState === "running"))).toBe(false);
    const chrome = panel.getByTestId("right-panel-tab-bar");
    const strip = chrome.getByTestId("file-tab-strip");
    for (const control of [review, active, chrome.getByRole("button", { name: "Panel layout", exact: true })]) {
      await expect(control).toBeInViewport();
      const bounds = (await chrome.boundingBox())!;
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    }
    expect((await strip.boundingBox())!.width).toBeGreaterThanOrEqual(80);
    await page.screenshot({ path: info.outputPath("passive-review.png") });
    // A review file can still be opened, but only through the review button.
    await review.click();
    await expect(active).not.toContainText("big-file.ts");
  });
}
