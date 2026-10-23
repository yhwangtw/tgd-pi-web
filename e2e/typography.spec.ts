import { test, expect } from "@playwright/test";

const SESSION = "/?session=ffff1111-2222-3333-4444-555566667777";

for (const [style, width, dark] of [["original", 1440, false], ["trae", 1440, true], ["original", 390, true], ["trae", 390, false]] as const) {
  test(`${style} ${width}px: UI labels share a family while code and paths stay mono`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.addInitScript(({ style, dark }) => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-theme", dark ? "dark" : "light");
      if (!localStorage.getItem("pi-font-family")) localStorage.setItem("pi-font-family", "sans");
      localStorage.setItem("pi-locale", "en");
    }, { style, dark });
    // The historical fixture predates per-message model metadata. Supply it
    // in the read response so this test actually exercises the model footer.
    await page.route(/\/api\/sessions\/ffff1111-2222-3333-4444-555566667777(?:\?|$)/, async route => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.context?.messages) data.context.messages = data.context.messages.map((message: { role: string }) =>
        message.role === "assistant" ? { ...message, provider: "anthropic", model: "claude-sonnet-5" } : message);
      await route.fulfill({ response, json: data });
    });
    await page.goto(SESSION);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    const input = page.getByRole("textbox", { name: "Message…", exact: true });
    await expect(input).toBeVisible();
    const uiFamily = await input.evaluate(el => getComputedStyle(el).fontFamily);
    expect(uiFamily).toContain("Inter");
    const model = page.locator('[class*="footerModel"]').first();
    await expect(model).toBeAttached();
    await expect(model).toHaveCSS("font-family", uiFamily);
    await expect(page.getByTestId("model-selector-trigger")).toHaveCSS("font-family", uiFamily);
    const workLog = page.locator('[data-work-log-expanded]').first();
    await expect(workLog).toBeAttached();
    await expect(workLog.locator('[class*="meta"]').first()).toHaveCSS("font-family", uiFamily);
    const code = page.locator('.markdown-body code').first();
    await expect(code).toBeAttached();
    expect(await code.evaluate(el => getComputedStyle(el).fontFamily)).toContain("JetBrains Mono");
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({ path: test.info().outputPath(`typography-${style}-${width}.png`), animations: "disabled" });

    // User preferences must affect labels as well as prose; technical text
    // keeps its own family even when the interface switches to system fonts.
    await page.evaluate(() => localStorage.setItem("pi-font-family", "system"));
    await page.reload();
    await expect(input).toBeVisible();
    const systemFamily = await input.evaluate(el => getComputedStyle(el).fontFamily);
    expect(systemFamily).toContain("system-ui");
    await expect(model).toHaveCSS("font-family", systemFamily);
    expect(await code.evaluate(el => getComputedStyle(el).fontFamily)).toContain("JetBrains Mono");
  });
}
