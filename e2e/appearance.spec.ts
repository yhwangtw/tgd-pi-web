import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("appearance", () => {
  test("picker panel: five skins, live apply, theme toggle, dismissal", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await expect(dialog).toBeVisible();

    const rows = dialog.getByRole("button").filter({ hasText: /Terminal|Industrial|Aurora|Editorial|Glass/ });
    await expect(rows).toHaveCount(5);

    await dialog.getByRole("button", { name: /Glass/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-skin")))
      .toBe("glass");
    await expect(dialog).toBeVisible(); // stays open for live preview

    await dialog.getByRole("button", { name: "Dark" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("skin + theme survive a reload via the no-flash init script", async ({ page }) => {
    await openMain(page);
    await page.evaluate(() => {
      localStorage.setItem("pi-skin", "glass");
      localStorage.setItem("pi-theme", "dark");
    });
    await page.reload();
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    const state = await page.evaluate(() => ({
      skin: document.documentElement.getAttribute("data-skin"),
      dark: document.documentElement.classList.contains("dark"),
    }));
    expect(state).toEqual({ skin: "glass", dark: true });
  });

  test("message layout switches between split and all-left and survives reload", async ({ page }) => {
    await openMain(page);
    const userMessage = page.getByTestId("user-message-row").first();
    const splitBox = await userMessage.boundingBox();
    expect(splitBox).not.toBeNull();

    await page.getByRole("button", { name: "Appearance" }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    await dialog.getByRole("button", { name: "All left" }).click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-message-layout")))
      .toBe("left");
    const leftBox = await userMessage.boundingBox();
    expect(leftBox).not.toBeNull();
    expect(leftBox!.x).toBeLessThan(splitBox!.x);

    await page.reload();
    await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-message-layout")))
      .toBe("left");

    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("dialog", { name: "Appearance" }).getByRole("button", { name: "Left & right" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-message-layout")))
      .toBe(false);
  });

  test("all-left layout remains aligned and usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMain(page);

    const row = page.getByTestId("user-message-row").first();
    const splitBox = await row.boundingBox();
    expect(splitBox).not.toBeNull();

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    const leftButton = dialog.getByRole("button", { name: "All left" });
    await expect(leftButton).toBeVisible();
    expect((await leftButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await leftButton.click();
    await page.keyboard.press("Escape");

    const leftBox = await row.boundingBox();
    expect(leftBox).not.toBeNull();
    expect(leftBox!.x).toBeLessThan(splitBox!.x);

    const userMessage = page.getByTestId("user-message").first();
    await userMessage.getByRole("button", { name: "More message actions" }).click();
    const actions = userMessage.getByTestId("user-message-actions");
    await expect(actions).toBeVisible();
    const actionsBox = await actions.boundingBox();
    expect(actionsBox).not.toBeNull();
    expect(actionsBox!.x).toBeGreaterThanOrEqual(0);
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(390);
  });

  test("default is editorial light", async ({ page }) => {
    await openMain(page);
    const state = await page.evaluate(() => ({
      skin: document.documentElement.getAttribute("data-skin"),
      dark: document.documentElement.classList.contains("dark"),
    }));
    expect(state.skin).toBe("editorial");
  });
});
