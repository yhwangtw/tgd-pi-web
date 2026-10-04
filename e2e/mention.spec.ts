import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function open(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("@file mention", () => {
  test("@ opens the menu, fuzzy search finds nested files, Enter inserts the path", async ({ page }) => {
    await open(page);
    const ta = page.locator("textarea").last();
    await ta.click();

    // Bare @ lists the project root; the menu caps entries, so use a directory
    // rather than relying on README's rank among files added by earlier specs.
    await ta.pressSequentially("@");
    const menu = page.getByTestId("file-mention-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByText("src/", { exact: true })).toBeVisible();

    // Fuzzy search finds nested files by name
    await ta.pressSequentially("index");
    await expect(menu.getByText("src/index.ts")).toBeVisible({ timeout: 5_000 });

    // Enter inserts the relative path and closes the menu
    await menu.getByText("src/index.ts").hover();
    await ta.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(ta).toHaveValue("@src/index.ts ");
  });

  test("directory drill-down with / does not open the slash menu", async ({ page }) => {
    await open(page);
    const ta = page.locator("textarea").last();
    await ta.click();

    await ta.pressSequentially("look at @src/");
    const menu = page.getByTestId("file-mention-menu");
    await expect(menu.getByText("src/index.ts")).toBeVisible({ timeout: 5_000 });
    // The slash-command menu must NOT be open (mid-text "/" is a path)
    await expect(page.getByText("/tgd-map", { exact: false }).first()).not.toBeVisible();

    await ta.press("Enter");
    await expect(ta).toHaveValue("look at @src/index.ts ");
  });

  test("slash commands still open from a leading /", async ({ page }) => {
    await open(page);
    const ta = page.locator("textarea").last();
    await ta.click();
    await ta.pressSequentially("/tgd");
    await expect(page.getByText("Map the codebase", { exact: false }).or(page.locator('[class*="SlashMenu_menu"]')).first()).toBeVisible();
  });
});
