import { isFixtureReadReceipt } from "./read-receipt-fixture";
import { expect, test as base, type Locator, type Page } from "@playwright/test";

const SESSION = "ffff1111-2222-3333-4444-555566667777";
const LONG_MODEL = "Fixture model with a deliberately long descriptive name for constrained composer layouts";
const MODEL_API = /\/api\/models(?:\?|$)/;

const test = base.extend<{ layoutNetworkSafety: void }>({
  layoutNetworkSafety: [async ({ page }, use) => {
    const forbidden: string[] = [];
    // Background suggestions have their own tests; layout actions must remain model-free.
    await page.addInitScript(() => localStorage.setItem("pi-composer-hints", "off"));
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      let body: Record<string, unknown> | undefined;
      try { body = request.postDataJSON(); } catch { /* Other mutations remain blocked. */ }
      if (request.method() === "POST" && pathname === "/api/worktrees" && body
        && Object.keys(body).length === 1 && Array.isArray(body.cwds) && body.cwds.length <= 128
        && body.cwds.every((cwd) => typeof cwd === "string" && cwd.length > 0)) return route.continue();
      if (request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(pathname) && body?.type === "get_tools") {
        return route.fulfill({ json: { success: true, data: [] } });
      }
      if (isFixtureReadReceipt(request)) return route.continue();
      forbidden.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 403, json: { error: "Composer layout tests forbid model calls and mutations" } });
    });
    await page.route(MODEL_API, (route) => route.fulfill({ json: {
      modelList: [
        // Use the stored fixture's model identity; historical sessions may
        // still show an unselected launcher until a live model is chosen.
        { provider: "anthropic", id: "claude-sonnet-5", name: LONG_MODEL, available: true, contextWindow: 200_000, maxTokens: 8_192 },
        { provider: "fixture-layout", id: "short-model", name: "Fixture short model", available: true, contextWindow: 32_768, maxTokens: 2_048 },
      ],
      defaultModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      thinkingLevels: {}, thinkingLevelMaps: {},
    } }));
    await page.route(/\/api\/sessions\/[^/?]+\?includeState$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, agentState: { running: false } } });
    });
    await use();
    expect(forbidden, "Opening, resizing, and closing composer controls must not call a model or mutate a session").toEqual([]);
  }, { auto: true }],
});

async function openFixture(page: Page, style: string, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((style) => {
    if (window !== window.top) return;
    localStorage.setItem("pi-ui-style", style);
    localStorage.setItem("pi-locale", "en");
  }, style);
  await page.goto(`/?session=${SESSION}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
  await expect(page.getByTestId("model-selector-trigger")).toHaveAttribute("data-catalog-status", "ready");
}

async function expectContained(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const viewport = page.viewportSize()!;
    return !!box && box.x >= -1 && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1;
  }, { message: "The whole overlay must fit inside the visible viewport" }).toBe(true);
}

async function expectModelAnchored(page: Page) {
  const listbox = page.getByTestId("model-selector-popover");
  const panel = listbox;
  await expectContained(page, panel);
  await expect.poll(async () => {
    const trigger = await page.getByTestId("model-selector-trigger").boundingBox();
    const box = await panel.boundingBox();
    if (!trigger || !box) return false;
    const gap = trigger.y - box.y - box.height;
    const clampedLeft = Math.max(8, Math.min(trigger.x, page.viewportSize()!.width - box.width - 8));
    return gap >= -1 && gap <= 16 && Math.abs(box.x - clampedLeft) <= 12;
  }, { message: "Model choices must follow their launcher after the conversation pane moves or resizes" }).toBe(true);
}

async function expectBottomSheet(page: Page, dialog: Locator) {
  await expectContained(page, dialog);
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return box ? Math.abs(page.viewportSize()!.height - box.y - box.height) : Infinity;
  }, { message: "A mobile composer picker must open against the bottom edge, not at the top of the screen" }).toBeLessThanOrEqual(2);
}

for (const style of ["original", "trae"] as const) {
  test(`${style}: collapsed icon controls expand into labeled, bounded keyboard controls`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openFixture(page, style, 1100, 850);
    const controls = page.getByRole("button", { name: "More composer controls", exact: true });
    await expect(controls).toHaveText("");
    await expect(controls).toHaveAttribute("title", "Composer controls");
    const model = page.getByTestId("model-selector-trigger");
    expect(await model.evaluate(el => getComputedStyle(el).fontFamily)).toBe(
      await page.getByRole("textbox", { name: "Message…", exact: true }).evaluate(el => getComputedStyle(el).fontFamily));
    await page.screenshot({ path: test.info().outputPath(`composer-icons-idle-${style}.png`) });
    await controls.click();
    const panel = page.getByRole("region", { name: "Composer controls", exact: true });
    await expectContained(page, panel);
    // Expanded controls intentionally expose their labels. At this desktop
    // width they may wrap into three compact rows; the idle trigger stays icon-only.
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(160);
    for (const label of ["Composer", "Reasoning", "Tools", "Response scroll", "Auto compact", "Context", "Sound"]) {
      await expect(panel.getByText(label, { exact: true })).toBeVisible();
    }
    const groupRows = await panel.locator('[class*="mobileLabeledControl"]').evaluateAll(elements =>
      elements.filter(element => element.getClientRects().length > 0).map(element => Math.round(element.getBoundingClientRect().y)));
    expect(new Set(groupRows).size).toBeLessThanOrEqual(3);
    for (const name of ["Change reasoning level", "Change tool preset"]) {
      const button = panel.getByRole("button", { name, exact: true });
      await expect(button).toHaveText("");
      await expect(button).toHaveAttribute("title", /.+: .+/);
      await button.click();
      await expectContained(page, page.getByRole("listbox", { name, exact: true }));
      await page.keyboard.press("Escape");
    }
    const smart = panel.getByRole("radio", { name: "Smart follow", exact: true });
    await smart.click();
    await smart.press("ArrowRight");
    await expect(panel.getByRole("radio", { name: "Always follow", exact: true })).toBeChecked();
    await expect(panel.getByRole("radio", { name: "Always follow", exact: true })).toBeFocused();
    await panel.getByRole("radio", { name: "Always follow", exact: true }).press("ArrowRight");
    await expect(panel.getByRole("radio", { name: "Preserve position", exact: true })).toBeChecked();
    await panel.getByRole("radio", { name: "Preserve position", exact: true }).press("Home");
    await expect(smart).toBeChecked();
    await page.screenshot({ path: test.info().outputPath(`composer-icons-open-${style}.png`) });
    await page.setViewportSize({ width: 701, height: 850 });
    await panel.getByRole("button", { name: "Change tool preset", exact: true }).click();
    await expectContained(page, page.getByRole("listbox", { name: "Change tool preset", exact: true }));
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await controls.click();
    await expect(panel).toBeHidden();
  });

  test(`${style}: desktop model popup follows resizing and the sidebar beside an open file preview`, async ({ page }) => {
    const selections: unknown[] = [];
    await page.route(`**/api/agent/${SESSION}`, route => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const command = request.postDataJSON();
      if (command.type !== "set_model") return route.fallback();
      selections.push(command);
      return route.fulfill({ json: { success: true } });
    });
    await openFixture(page, style, 1440);
    await page.getByRole("link", { name: "查看成果", exact: true }).click();
    await expect(page.locator(".right-panel-open").locator('iframe[title="HTML preview"]')).toBeVisible();
    const trigger = page.getByTestId("model-selector-trigger");
    const controls = page.getByRole("button", { name: "More composer controls", exact: true });
    await controls.click();
    await expect(page.getByRole("region", { name: "Composer controls", exact: true })).toBeVisible();
    await trigger.click();
    await expect(page.getByRole("region", { name: "Composer controls", exact: true })).toBeHidden();
    await expect(controls).toHaveAttribute("aria-expanded", "false");
    await expectModelAnchored(page);
    const selected = page.getByTestId("model-selector-popover").getByRole("button", { name: new RegExp(LONG_MODEL) });
    await selected.click();
    expect(selections).toEqual([{ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" }]);
    await expect(page.getByTestId("model-selector-popover")).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expectModelAnchored(page);
    await page.setViewportSize({ width: 1280, height: 760 });
    await expectModelAnchored(page);
    // The real sidebar shortcut preserves the open picker, exposing stale
    // launcher coordinates without an outside pointer click closing it first.
    await page.keyboard.press("ControlOrMeta+b");
    await expectModelAnchored(page);
    await page.screenshot({ path: test.info().outputPath(`composer-model-desktop-${style}.png`) });
    await page.keyboard.press("ControlOrMeta+b");
    await expectModelAnchored(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-selector-popover")).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  for (const width of [320, 390, 700]) {
    test(`${style} ${width}px: model and Controls are bottom sheets with stable close and focus`, async ({ page }) => {
      await openFixture(page, style, width, width === 700 ? 430 : 900);
      const composer = page.getByRole("textbox", { name: "Message…", exact: true });
      await composer.fill("Keep this draft while using controls");
      const trigger = page.getByTestId("model-selector-trigger");
      const modelDialog = page.getByRole("dialog", { name: "Choose a model", exact: true });
      await trigger.click();
      await expectBottomSheet(page, modelDialog);
      await expect(modelDialog.getByRole("searchbox", { name: "Search models", exact: true })).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`composer-model-${width}-${style}.png`) });
      await page.keyboard.press("Escape");
      await expect(modelDialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expectBottomSheet(page, modelDialog);
      await modelDialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(modelDialog).toBeHidden();

      const controls = page.getByRole("button", { name: "More composer controls", exact: true });
      const controlsDialog = page.getByRole("dialog", { name: "Composer controls", exact: true });
      await controls.click();
      await expectBottomSheet(page, controlsDialog);
      await page.screenshot({ path: test.info().outputPath(`composer-controls-${width}-${style}.png`) });
      await page.keyboard.press("Escape");
      await expect(controlsDialog).toBeHidden();
      await expect(controls).toBeFocused();
      await controls.click();
      await expectBottomSheet(page, controlsDialog);
      await controlsDialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(controlsDialog).toBeHidden();
      await expect(composer).toHaveValue("Keep this draft while using controls");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    });
  }

  test(`${style} 701px: desktop picker survives crossing the mobile breakpoint`, async ({ page }) => {
    await openFixture(page, style, 701);
    const trigger = page.getByTestId("model-selector-trigger");
    await trigger.click();
    await expectModelAnchored(page);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 700, height: 900 });
    // The expanded desktop sidebar becomes the Sessions page on phones.
    await page.getByRole("navigation", { name: "Primary navigation", exact: true }).getByRole("button", { name: "Chat", exact: true }).click();
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await trigger.click();
    await expectBottomSheet(page, page.getByRole("dialog", { name: "Choose a model", exact: true }));
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 701, height: 900 });
    await trigger.click();
    await expectModelAnchored(page);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}
