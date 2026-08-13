import { expect, test } from "@playwright/test";

const OUTPUT_SESSION = "bbbb1111-2222-3333-4444-555566667777";

test.describe("Output Design System", () => {
  test("keeps prose primary and progressive evidence interactive", async ({ page }) => {
    await page.goto(`/?session=${OUTPUT_SESSION}`);

    await expect(page.getByText("已重新啟動開發伺服器，並確認運行正常。", { exact: true })).toBeVisible();
    const workLog = page.getByRole("region", { name: "Work log" });
    const result = page.getByTestId("structured-output-card");
    await expect(workLog).toBeVisible();
    await expect(result).toHaveAttribute("data-output-kind", "result");
    await expect(result.getByText("開發伺服器運行中", { exact: true })).toBeVisible();
    const evidence = result.getByText(/確認服務回傳 HTTP 200/);
    await expect(evidence).toBeHidden();

    await result.getByText("技術細節", { exact: true }).click();
    await expect(evidence).toBeVisible();
  });

  test("fits the result and disclosure on a narrow phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?session=${OUTPUT_SESSION}`);

    const result = page.getByTestId("structured-output-card");
    await expect(result).toBeVisible();
    const metrics = await result.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
    }));
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewport + 1);
  });
});
