import { expect, test, type Page } from "@playwright/test";

async function mockUnread(page: Page, count: number) {
  await page.route("**/api/attention", route => route.fulfill({ json: {
    serverTime: new Date().toISOString(),
    items: Array.from({ length: count }, (_, i) => ({ id: `notice-${i}`, source: "session", severity: "success", status: "completed", title: `Review ${i + 1} complete`, summary: "Ready to review when you are.", occurredAt: new Date().toISOString() })),
  } }));
}

for (const style of ["original", "trae"]) for (const skin of ["terminal", "trae", "glass"]) for (const theme of ["light", "dark"]) {
  test(`${style} ${skin} ${theme}: unread stays quiet, fixed size, and keyboard accessible`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(({ style, skin, theme }) => {
      localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-skin", skin); localStorage.setItem("pi-theme", theme);
      localStorage.setItem("pi-font-size", "xlarge");
    }, { style, skin, theme });
    await mockUnread(page, 150);
    await page.goto("/");
    const button = page.getByRole("button", { name: "Attention · 150 unread", exact: true });
    const dot = button.getByTestId("attention-unread-dot");
    await expect(dot).toBeVisible();
    await expect(button).toHaveAttribute("title", "Attention · 150 unread");
    await expect(dot).toHaveText("");
    const geometry = await dot.evaluate(el => {
      const rect = el.getBoundingClientRect(); const button = el.parentElement!.getBoundingClientRect();
      const style = getComputedStyle(el); const theme = getComputedStyle(document.documentElement);
      return { width: rect.width, height: rect.height, inside: rect.left >= button.left && rect.right <= button.right && rect.top >= button.top && rect.bottom <= button.bottom, color: style.backgroundColor, accent: theme.getPropertyValue("--accent").trim(), error: theme.getPropertyValue("--color-error").trim() };
    });
    expect(geometry.width).toBe(6); expect(geometry.height).toBe(6); expect(geometry.inside).toBe(true);
    const isAccent = await dot.evaluate(el => {
      const probe = document.createElement("span"); probe.style.color = "var(--accent)"; el.append(probe);
      const same = getComputedStyle(el).backgroundColor === getComputedStyle(probe).color; probe.remove(); return same;
    });
    expect(isAccent).toBe(true);
    await button.hover();
    await page.mouse.move(400, 300);
    if (theme === "light") await page.screenshot({ path: test.info().outputPath(`notification-${style}-${skin}.png`), clip: { x: 0, y: 0, width: 440, height: 230 } });
    await button.focus(); await button.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    const panel = page.getByRole("region", { name: "Attention", exact: true });
    await expect(panel.getByRole("heading", { name: "Attention", exact: true })).toBeVisible();
    await expect(panel).toContainText("150 unread");
    await expect(panel.locator('[class*="unreadCount"]')).toHaveText("99+");
    await panel.getByRole("button", { name: "Read all", exact: true }).click();
    await expect(page.getByTestId("attention-unread-dot")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Attention", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
}

for (const style of ["original", "trae"]) for (const width of [320, 390]) {
  test(`${style} ${width}px: mobile count stays beside the label, never over the bell`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(style => {
      localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", "xlarge");
    }, style);
    await mockUnread(page, 150);
    await page.goto("/");
    await page.getByRole("button", { name: "More", exact: true }).click();
    const button = page.getByRole("button", { name: "Attention · 150 unread", exact: true });
    const count = button.locator('[class*="mobileActionBadge"]');
    await expect(count).toHaveText("99+");
    const badgeBox = await count.boundingBox(); const iconBox = await button.locator("svg").boundingBox();
    const adjacentIconBox = await page.getByRole("button", { name: "Agents", exact: true }).locator("svg").boundingBox();
    expect(Math.abs(iconBox!.y - adjacentIconBox!.y)).toBeLessThanOrEqual(1);
    expect(badgeBox!.y).toBeGreaterThanOrEqual(iconBox!.y + iconBox!.height);
    expect(await button.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`notification-mobile-${style}-${width}.png`) });
    await button.click();
    await expect(page.getByRole("heading", { name: "Attention", exact: true })).toBeVisible();
  });
}
