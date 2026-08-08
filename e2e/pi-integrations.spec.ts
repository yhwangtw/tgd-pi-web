import { expect, test, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("Pi integration centers", () => {
  test("provider health opens from Models and reports credential readiness", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: /Models/ }).first().click();
    const dialog = page.getByTestId("models-config-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("provider-health")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("heading", { name: "Provider health" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Run checks" })).toBeVisible();
    await expect(dialog.getByText("Providers", { exact: true })).toBeVisible();
  });

  test("package center exposes a guarded, responsive user-scope install flow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMain(page);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Extensions", exact: true }).click();
    const dialog = page.getByTestId("extensions-config");
    await dialog.getByRole("tab", { name: "Packages" }).click();
    const center = dialog.getByTestId("package-center");
    await expect(center).toBeVisible();
    await expect(center.getByText("Packages can execute code", { exact: true })).toBeVisible();
    await expect(center.getByRole("textbox", { name: "Package source" })).toBeVisible();
    await expect(center.getByRole("button", { name: "Review install" })).toBeDisabled();
    expect(await center.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test("context inspector reveals effective sources, skills, and tools", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Session actions" }).click();
    await page.getByRole("menuitem", { name: /System/ }).click();
    const inspector = page.getByTestId("context-inspector");
    await expect(inspector).toBeVisible({ timeout: 20_000 });
    await expect(inspector.getByRole("tab", { name: /Instructions/ })).toBeVisible();
    await expect(inspector.getByRole("tab", { name: /Skills/ })).toBeVisible();
    await expect(inspector.getByRole("tab", { name: /Tools/ })).toBeVisible();
    await inspector.getByRole("tab", { name: /Instructions/ }).click();
    await expect(inspector.getByText("Effective system prompt", { exact: true })).toBeVisible();
  });
});
