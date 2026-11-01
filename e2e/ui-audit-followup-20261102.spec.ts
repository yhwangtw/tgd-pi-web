import { expect, test as base, type Page } from "@playwright/test";
import { isFixtureReadReceipt } from "./read-receipt-fixture";

const SESSION = "aaaa1111-2222-3333-4444-555566667777";
const test = base.extend<{ readOnlyUI: void }>({
  readOnlyUI: [async ({ page }, use) => {
    const forbidden: string[] = [];
    await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET" && pathname === "/api/attention") return route.fulfill({ json: {
        items: [{ id: "ui-audit-attention", source: "session", severity: "warning", status: "interrupted",
          title: "Fixture needs attention", summary: "Inert UI test data", occurredAt: new Date().toISOString() }], serverTime: new Date().toISOString(),
      } });
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      let body: Record<string, unknown> | undefined;
      try { body = request.postDataJSON(); } catch { /* Deny unrecognized writes. */ }
      if (request.method() === "POST" && pathname === "/api/models" && body
        && Object.keys(body).length === 1 && typeof body.cwd === "string") return route.fulfill({ json: {
          modelList: [{ provider: "anthropic", id: "claude-sonnet-5", name: "Fixture model", available: true }],
          thinkingLevels: {}, thinkingLevelMaps: {},
        } });
      if (request.method() === "POST" && pathname === "/api/worktrees" && body
        && Object.keys(body).length === 1 && Array.isArray(body.cwds)
        && body.cwds.length <= 128 && body.cwds.every(cwd => typeof cwd === "string" && cwd.length > 0)) return route.continue();
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools")
        return route.fulfill({ json: { success: true, data: [] } });
      if (isFixtureReadReceipt(request)) return route.continue();
      forbidden.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: "UI regression tests forbid inference and server mutations" } });
    });
    await use();
    expect(forbidden).toEqual([]);
  }, { auto: true }],
});

async function open(page: Page, style: string, width: number, height = 900, skin = "trae", dark = false) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ style, skin, dark }) => {
    localStorage.setItem("pi-ui-style", style); localStorage.setItem("pi-skin", skin);
    localStorage.setItem("pi-theme", dark ? "dark" : "light"); localStorage.setItem("pi-locale", "en");
  }, { style, skin, dark });
  await page.goto(`/?session=${SESSION}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
  if (width <= 700) await page.getByRole("button", { name: "Chat", exact: true }).click();
}

for (const style of ["original", "trae"]) {
  for (const width of [320, 390]) {
    test(`${style} ${width}px: More preserves draft, isolates focus, dismisses and shows unread attention`, async ({ page }) => {
      test.setTimeout(20_000);
      await open(page, style, width, 844);
      const editor = page.getByRole("textbox", { name: "Message…", exact: true });
      await editor.fill("Keep this draft; never send it.");
      await page.getByRole("button", { name: "Session actions", exact: true }).focus();
      const more = page.getByRole("button", { name: "More", exact: true });
      await expect(more.getByTestId("mobile-attention-unread-dot")).toBeVisible();
      await expect(more).toHaveAccessibleDescription("1 unread notifications");
      await more.click();
      const dialog = page.getByRole("dialog", { name: "More", exact: true });
      const close = dialog.getByRole("button", { name: "Close more tools", exact: true });
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(close).toBeFocused();
      const dialogBox = await dialog.boundingBox();
      const navBox = await page.locator('nav[class*="mobileNav"]').boundingBox();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width);
      expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(navBox!.y);
      await expect(close).toBeInViewport();
      expect(await page.getByTestId("app-shell").evaluate(el => !!el.closest("[inert]"))).toBe(true);
      const last = dialog.getByRole("button").last();
      await last.focus(); await page.keyboard.press("Tab"); await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab"); await expect(last).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`more-${style}-${width}.png`) });
      await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(more).toBeFocused();
      await expect(editor).toHaveValue("Keep this draft; never send it.");
      await more.click();
      await page.evaluate(() => document.documentElement.style.setProperty("--font-scale", "2"));
      const enlargedDialog = await dialog.boundingBox();
      const enlargedNav = await page.locator('nav[class*="mobileNav"]').boundingBox();
      expect(enlargedDialog!.y).toBeGreaterThanOrEqual(0);
      expect(enlargedDialog!.y + enlargedDialog!.height).toBeLessThanOrEqual(enlargedNav!.y);
      await expect(close).toBeInViewport();
      await page.mouse.click(2, 80); await expect(dialog).toHaveCount(0);
      await more.click(); await page.setViewportSize({ width: 667, height: 320 });
      const landscape = await dialog.boundingBox();
      const landscapeNav = await page.locator('nav[class*="mobileNav"]').boundingBox();
      expect(landscape!.y).toBeGreaterThanOrEqual(0);
      expect(landscape!.y + landscape!.height).toBeLessThanOrEqual(landscapeNav!.y);
      await expect(close).toBeInViewport();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => page.getByTestId("app-shell").evaluate(el => !!el.closest("[inert]"))).toBe(false);
    });
  }

  test(`${style}: search, skill toggle and code line input have visible keyboard focus`, async ({ page }) => {
    await open(page, style, 1440);
    const search = page.getByRole("textbox", { name: "Find in conversation…", exact: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.keyboard.press("ControlOrMeta+f");
      await expect(search).toBeFocused();
      await page.getByRole("button", { name: "Close find", exact: true }).click();
    }
    await page.keyboard.press("ControlOrMeta+f");
    await expect(search).toBeFocused(); await page.keyboard.press("Shift+Tab");
    const scope = page.getByRole("combobox", { name: "Search scopes", exact: true });
    await expect(scope).toBeFocused();
    expect(await scope.evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.getByRole("button", { name: "Close find", exact: true }).click();
    const focusCode = page.getByRole("button", { name: "Open focus mode", exact: true }).first();
    await focusCode.scrollIntoViewIfNeeded();
    await expect(focusCode).toBeInViewport();
    await focusCode.click();
    const codeDialog = page.getByRole("dialog");
    const lineInput = codeDialog.locator("input");
    await lineInput.focus();
    expect(await lineInput.evaluate(el => getComputedStyle(el.parentElement!).outlineStyle)).toBe("solid");
    await codeDialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    const skills = page.getByRole("dialog", { name: "Skills", exact: true });
    const toggle = skills.locator('button[class*="SkillDetail_toggle"]');
    await expect(toggle).toBeVisible();
    await toggle.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    expect(await toggle.evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  for (const dark of [false, true]) {
    test(`${style} glass ${dark ? "dark" : "light"}: historical fade uses alpha without a painted rectangle`, async ({ page }) => {
      await open(page, style, 1440, 900, "glass", dark);
      const expand = page.getByRole("button", { name: /Show full message/ }).first();
      await expand.scrollIntoViewIfNeeded();
      const clip = expand.locator("..").locator('div[class*="clip"]');
      expect(await clip.evaluate(el => getComputedStyle(el).maskImage)).toContain("linear-gradient");
      expect(await clip.locator('[class*="fade"]').count()).toBe(0);
      expect(await page.locator('div[class*="composerDock"]').evaluate(el => getComputedStyle(el).backgroundImage)).toBe("none");
      await page.screenshot({ path: test.info().outputPath(`fade-${style}-${dark ? "dark" : "light"}.png`) });
      await expand.click();
      await expect(page.getByRole("button", { name: "Collapse message", exact: true })).toBeVisible();
      await expect(clip).toHaveCount(0);
    });
  }
}

test("mobile file viewer is distinct from browsing files", async ({ page }) => {
  await open(page, "original", 390, 844);
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Files", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Session actions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show file panel", exact: true })).toHaveText("File viewer");
});

test.describe("initial browser language", () => {
  test.use({ locale: "zh-TW", reducedMotion: "reduce" });
  for (const saved of [null, "en", "zh"]) {
  test(`Chinese browser follows the initial language and preserves saved=${saved}`, async ({ page }) => {
    await page.addInitScript(saved => {
      if (saved) localStorage.setItem("pi-locale", saved); else localStorage.removeItem("pi-locale");
    }, saved);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const chinese = saved !== "en";
    await expect(page.locator("html")).toHaveAttribute("lang", chinese ? "zh-Hant-TW" : "en");
    await page.getByRole("button", { name: chinese ? "開始新對話" : "Start a conversation", exact: true }).click();
    await expect(page.getByTestId("welcome-typewriter")).toHaveText(chinese ? "準備好就開始。" : "ready when you are.");
    await expect(page.getByRole("textbox", { name: chinese ? "輸入訊息…" : "Message…", exact: true })).toBeEditable();
  });
  }
});
