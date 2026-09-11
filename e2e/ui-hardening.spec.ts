import { test, expect, type Page } from "@playwright/test";

const SID = "aaaa1111-2222-3333-4444-555566667777";
const MAIN = `/?session=${SID}`;

async function openSession(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
  // The compact mobile header intentionally hides the secondary session title.
  await expect(page.getByText("專案架構分析").first()).toBeAttached();
  await expect(page.getByRole("textbox", { name: "Message…", exact: true })).toBeVisible();
}

for (const style of ["original", "trae"]) {
  test(`${style}: file menu escapes clipping and owns keyboard focus`, async ({ page }) => {
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-right-width", "350");
    }, style);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSession(page);
    await page.getByRole("button", { name: /^(Explorer|Files)$/ }).first().click();
    await page.getByRole("treeitem", { name: "README.md" }).click();
    await page.getByRole("button", { name: "Raw", exact: true }).click();
    const trigger = page.getByRole("button", { name: "More file actions" });
    await trigger.focus();
    await trigger.press("Enter");
    const menu = page.getByRole("menu", { name: "More file actions" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Edit file", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem").last()).toBeFocused();
    await expect(menu.getByRole("menuitem").last()).toBeInViewport();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    await page.screenshot({ path: test.info().outputPath(`file-menu-${style}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.press("Enter");
    await menu.getByRole("menuitem", { name: "Edit file", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Focus mode", exact: true }).click();
    const viewer = page.locator('[class*="TextFileViewer_fullscreen"]');
    await expect(viewer).toBeVisible();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(viewer).toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder") ?? document.activeElement?.outerHTML.slice(0, 300))).toBe("find / :line");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
  });

  test(`${style}: mobile labels, controls and attachment targets at Default and XL`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-font-size", sessionStorage.getItem("test-font-size") ?? "default");
    }, style);
    for (const size of ["default", "xlarge"]) {
      for (const width of [320, 390, 700]) {
        await page.setViewportSize({ width, height: 850 });
        await openSession(page);
        await page.evaluate(size => sessionStorage.setItem("test-font-size", size), size);
        await openSession(page);
        await page.getByRole("button", { name: "More composer controls" }).click();
        const dialog = page.getByRole("dialog", { name: "Composer controls" });
        await expect(dialog).toBeVisible();
        const cards = dialog.locator('[class*="mobileLabeledControl"]');
        expect(await cards.count()).toBeGreaterThan(3);
        await expect(dialog.getByText("Expand", { exact: true })).toBeVisible();
        const overlaps = await cards.evaluateAll(elements => elements.flatMap(element => {
          const label = element.querySelector<HTMLElement>('[class*="mobileControlLabel"]');
          if (!label) return [];
          const labelBox = label.getBoundingClientRect();
          const controls = Array.from(element.querySelectorAll<HTMLElement>('button')).filter(button => button.getClientRects().length > 0);
          return controls.flatMap(button => {
            const b = button.getBoundingClientRect();
            return b.top < labelBox.bottom - 1 || b.height < 43 || b.left < 0 || b.right > innerWidth + 1
              ? [`${label.textContent}: ${button.textContent}`] : [];
          });
        }));
        expect(overlaps, `${style} ${width}px ${size}`).toEqual([]);
        const radios = dialog.getByRole("radiogroup", { name: "Change response scroll mode" });
        await radios.getByRole("radio", { name: "Smart follow" }).click();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-scroll-follow-mode"))).toBe("always");
        await page.keyboard.press("End");
        await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-scroll-follow-mode"))).toBe("preserve");
        if (width === 390 && size === "xlarge") await page.screenshot({ path: test.info().outputPath(`mobile-xl-${style}.png`) });
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await page.locator('input[type="file"]').first().setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64") });
        const remove = page.getByRole("button", { name: "Remove image", exact: true });
        await expect(remove).toBeVisible();
        const b = (await remove.boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
        await remove.click();
        await expect(remove).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  });

  test(`${style}: repo and branch have a dedicated line with scaled virtual rows`, async ({ page }) => {
    await page.addInitScript(style => localStorage.setItem("pi-ui-style", style), style);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSession(page);
    const row = page.locator(`[data-session-row="${SID}"]`);
    const workspace = row.locator('[class*="workspaceMeta"]');
    await expect(workspace).toContainText("demo-project");
    await expect(workspace).toContainText("main");
    const outputPreview = page.locator('[data-session-row="bbbb1111-2222-3333-4444-555566667777"] [class*="previewRow"]');
    await expect(outputPreview).not.toContainText("[!RESULT]");
    await expect(outputPreview).not.toContainText(">");
    for (const size of ["default", "xlarge"]) {
      await page.evaluate(size => document.documentElement.dataset.fontSize = size, size);
      await expect.poll(async () => {
        const rows = page.locator('[data-session-row]');
        return rows.evaluateAll(elements => elements.every(element => {
          const content = element.querySelector('[class*="previewRow"]')!;
          return content.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1;
        }));
      }).toBe(true);
      const identityBox = (await workspace.boundingBox())!;
      const excerptBox = (await row.locator('[class*="previewRow"]').boundingBox())!;
      expect(excerptBox.y).toBeGreaterThanOrEqual(identityBox.y + identityBox.height - 1);
      const rows = await page.locator('[class*="virtualSessionRow"]').evaluateAll(elements => elements.map(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })));
      for (let i = 1; i < rows.length; i++) expect(rows[i].top).toBeGreaterThanOrEqual(rows[i - 1].bottom - 1);
    }
    await page.screenshot({ path: test.info().outputPath(`session-identity-${style}.png`) });
  });
}

test("pending and failed Git lookups never pretend the folder is not a repository", async ({ page }) => {
  let releaseLookup!: () => void;
  const pending = new Promise<void>(resolve => { releaseLookup = resolve; });
  await page.route("**/api/worktrees?*", async route => {
    await pending;
    await route.fulfill({ status: 500, json: { error: "Fixture Git unavailable" } });
  });
  await openSession(page);
  const workspace = page.locator('[class*="AppShell_workspaceIdentity"]');
  await expect(workspace).toContainText("Loading Git…");
  await expect(workspace).not.toContainText("Not a Git");
  releaseLookup();
  await expect(workspace).toContainText("Git unavailable");
  await expect(workspace).not.toContainText("Not a Git");
});
