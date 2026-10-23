import { expect, test } from "@playwright/test";

for (const style of ["original", "trae"]) {
  test(`${style}: 200% text keeps composer, file tabs and inspector notes usable`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-theme", "dark");
    }, style);
    // Inspector symbol loading is outside this typography check.
    await page.route("**/api/files/insights**", route => route.fulfill({ json: { diagnostics: [], commits: [], lines: [], matches: [] } }));
    for (const width of [320, 840, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/?session=ffff1111-2222-3333-4444-555566667777");
      await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
      if (width <= 700) await page.getByRole("button", { name: "Chat", exact: true }).click();
      await page.evaluate(() => document.documentElement.style.setProperty("--font-scale", "2"));
      if (width <= 700) {
        const clippedNavigation = await page.locator('nav[class*="mobileNav"] button > span:last-child').evaluateAll(labels => labels.flatMap(label => {
          const bounds = label.getBoundingClientRect();
          const button = label.parentElement!.getBoundingClientRect();
          return bounds.left >= button.left && bounds.right <= button.right + 1 && bounds.bottom <= button.bottom + 1
            && label.scrollWidth <= label.clientWidth + 1 ? [] : [label.textContent];
        }));
        expect(clippedNavigation, "Enlarged mobile navigation labels must wrap inside their own touch targets").toEqual([]);
      }
      const composer = page.getByRole("textbox", { name: "Message…", exact: true });
      await composer.fill("Keep this enlarged-text draft");
      const controls = page.getByRole("button", { name: "More composer controls", exact: true });
      await controls.click();
      const controlsPanel = width <= 700
        ? page.getByRole("dialog", { name: "Composer controls", exact: true })
        : page.getByRole("region", { name: "Composer controls", exact: true });
      await expect(controlsPanel).toBeVisible();
      expect(await controlsPanel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (width <= 700) await page.keyboard.press("Escape"); else await controls.click();
      await expect(composer).toHaveValue("Keep this enlarged-text draft");
      await page.getByRole("link", { name: "查看程式", exact: true }).click();
      const panel = page.locator(".right-panel-open");
      await expect(panel.getByTestId("file-viewer-toolbar")).toBeVisible();
      const tab = panel.getByRole("tab", { selected: true });
      await expect(tab).toBeVisible();
      expect(await tab.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await panel.getByRole("button", { name: "Inspector", exact: true }).click();
      const inspector = page.getByTestId("file-inspector");
      await inspector.getByRole("tab", { name: "Notes", exact: true }).click();
      const note = inspector.getByRole("textbox", { name: "Note", exact: true });
      await note.fill("Review this line at twice the normal text size.");
      await note.scrollIntoViewIfNeeded();
      const clipped = await inspector.locator("input, textarea, form button").evaluateAll(elements => elements.flatMap(element => {
        const bounds = element.getBoundingClientRect();
        const host = element.closest("form")!.getBoundingClientRect();
        const fits = bounds.width > 0 && bounds.left >= host.left - 1 && bounds.right <= host.right + 1
          && (element.tagName === "TEXTAREA" || element.scrollHeight <= element.clientHeight + 1);
        return fits ? [] : [{ tag: element.tagName, width: bounds.width, left: bounds.left, right: bounds.right,
          formLeft: host.left, formRight: host.right, scroll: element.scrollHeight, client: element.clientHeight }];
      }));
      expect(clipped, `${style}/${width}: note fields and Add must remain inside the form without clipping; multiline notes may scroll`).toEqual([]);
      const noteBounds = (await note.boundingBox())!;
      const addBounds = (await inspector.getByRole("button", { name: "Add", exact: true }).boundingBox())!;
      expect(addBounds.y, "With enlarged text, Notes should stack rather than squeeze the editor between Line and Add").toBeGreaterThanOrEqual(noteBounds.y + noteBounds.height - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`enlarged-${style}-${width}.png`) });
    }
  });
}
