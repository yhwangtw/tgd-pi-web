import { expect, test as base, type Locator, type Page } from "@playwright/test";

const SESSION = "ffff1111-2222-3333-4444-555566667777";

const test = base.extend<{ layoutNetworkSafety: void }>({
  layoutNetworkSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      let body: Record<string, unknown> | undefined;
      try { body = request.postDataJSON(); } catch { /* Other mutations remain blocked. */ }
      if (request.method() === "POST" && pathname === "/api/worktrees" && body
        && Object.keys(body).length === 1 && Array.isArray(body.cwds)
        && body.cwds.length <= 128 && body.cwds.every((cwd) => typeof cwd === "string" && cwd.length > 0)) return route.continue();
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools") {
        return route.fulfill({ json: { success: true, data: [] } });
      }
      forbidden.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: "Ergonomics tests forbid model calls and mutations" } });
    });
    await page.route(/\/api\/models(?:\?|$)/, (route) => route.fulfill({ json: {
      modelList: [{ provider: "anthropic", id: "claude-sonnet-5", name: "Fixture model", available: true }],
      thinkingLevels: {}, thinkingLevelMaps: {},
    } }));
    await page.route(/\/api\/sessions\/[^/?]+\?includeState$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, agentState: { running: false } } });
    });
    await use();
    expect(forbidden, "Layout checks must never send drafts or change server state").toEqual([]);
  }, { auto: true }],
});

async function openFixture(page: Page, style: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((style) => {
    localStorage.setItem("pi-ui-style", style);
    localStorage.setItem("pi-locale", "en");
  }, style);
  await page.goto(`/?session=${SESSION}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
}

async function expectContained(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize()!;
    return !!box && box.x >= -1 && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1;
  }, { message: "The full control must remain inside the resized viewport" }).toBe(true);
}

for (const style of ["original", "trae"] as const) {
  for (const scale of [1, 2]) {
    test(`${style} 320px ${scale * 100}%: whole navigation labels remain reachable without covering the composer`, async ({ page }) => {
      await openFixture(page, style, 320, 740);
      // Deliberately enlarge the existing text token, not CSS zoom (which
      // scales the entire page). Synthetic insets exercise padding geometry.
      await page.evaluate((scale) => {
        document.documentElement.style.setProperty("--font-scale", String(scale));
        document.documentElement.style.setProperty("--safe-area-bottom", "18px");
        document.documentElement.style.setProperty("--safe-area-left", "8px");
        document.documentElement.style.setProperty("--safe-area-right", "8px");
      }, scale);
      const navigation = page.getByRole("navigation", { name: "Primary navigation", exact: true });
      await expectContained(page, navigation);
      const buttons = navigation.getByRole("button");
      await expect(buttons).toHaveCount(5);
      for (const button of await buttons.all()) {
        await button.focus();
        await expect(button).toBeFocused();
        await expectContained(page, button);
        const label = button.locator("span").last();
        expect(await label.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        }), "A navigation word must not split across lines").toBe(1);
      }
      const metrics = await navigation.evaluate((element) => ({
        navTop: element.getBoundingClientRect().top,
        scrollable: element.scrollWidth > element.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      if (scale === 1) expect(metrics.scrollable).toBe(false);
      const composer = await page.getByTestId("composer-toolbar").boundingBox();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(metrics.navTop + 1);
      expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      await page.screenshot({ path: test.info().outputPath(`navigation-${style}-${scale * 100}.png`) });
    });
  }

  test(`${style}: the expanded draft stays usable after a short viewport and landscape resize`, async ({ page }) => {
    await openFixture(page, style, 390, 740);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /interactive-widget=resizes-content/);
    const draft = Array.from({ length: 30 }, (_, index) => `Draft line ${index + 1}; never send.`).join("\n");
    await page.getByRole("textbox", { name: "Message…", exact: true }).fill(draft);
    await expect(page.locator("[data-composer-editing]")).toHaveAttribute("data-composer-editing", "true");
    const navigation = page.getByRole("navigation", { name: "Primary navigation", exact: true });
    await expect(navigation).not.toBeInViewport();
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await page.getByRole("button", { name: "Expand composer", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Message…", exact: true });
    for (const viewport of [{ width: 390, height: 320 }, { width: 667, height: 320 }, { width: 1440, height: 900 }, { width: 390, height: 740 }]) {
      // These are layout viewport resizes, not a physical iOS/Android keyboard.
      await page.setViewportSize(viewport);
      await expectContained(page, editor);
      await expectContained(page, page.getByRole("button", { name: "Send", exact: true }));
      await expectContained(page, page.getByRole("button", { name: "Collapse composer", exact: true }));
      const editorDialog = page.getByRole("dialog", { name: "Expanded composer", exact: true });
      const covered = await editorDialog.evaluate(element => {
        const points = [16, window.innerWidth / 2, window.innerWidth - 16]
          .flatMap(x => [48, 88].map(y => ({ x, y })));
        return points.filter(({ x, y }) => !element.contains(document.elementFromPoint(x, y)));
      });
      expect(covered, "App header/navigation must not cover the expanded editor's hit surface").toEqual([]);
      await expect(editor).toBeEditable();
      await expect(editor).toHaveValue(draft);
      expect(await editor.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 667, height: 320 });
    expect(await editor.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`expanded-landscape-${style}.png`) });
    // Test keyboard collapse without submitting the draft.
    await editor.focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Collapse composer", exact: true })).toHaveCount(0);
    await expect(editor).toHaveValue(draft);
  });
}
