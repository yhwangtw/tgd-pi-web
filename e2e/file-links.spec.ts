import { test, expect } from "@playwright/test";

// The ffff… fixture's assistant message contains `src/index.ts` as inline
// code, and that file exists in the demo project.
const TOOLS = "/?session=ffff1111-2222-3333-4444-555566667777";

test.describe("file-path links in chat", () => {
  test("clicking a file-path inline code opens it in the viewer", async ({ page }) => {
    await page.goto(TOOLS);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByText("工具呼叫測試").first()).toBeVisible({ timeout: 20_000 });

    const link = page.locator('code[role="link"]', { hasText: "src/index.ts" }).first();
    await expect(link).toBeVisible();
    await link.click();

    // Right panel opens the file: tab label + real file content
    await expect(page.getByText("export const answer").first()).toBeVisible({ timeout: 10_000 });
  });

  test("non-path inline code is not clickable", async ({ page }) => {
    await page.goto(TOOLS);
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByText("工具呼叫測試").first()).toBeVisible({ timeout: 20_000 });

    // `answer` (final assistant message) is inline code but not a file path
    const plain = page.locator("code", { hasText: /^answer$/ }).first();
    await expect(plain).toBeVisible();
    await expect(plain).not.toHaveAttribute("role", "link");
  });
});
