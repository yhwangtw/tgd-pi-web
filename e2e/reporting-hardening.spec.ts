import { test, expect } from "@playwright/test";
import { buildSessionAnalyticsReport } from "../lib/session-analytics";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";
const report = buildSessionAnalyticsReport([{
  id: "report-fixture", cwd: "/fixture/project", name: "Reporting fixture", created: "2026-01-01", modified: "2026-09-05",
  entries: [
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", provider: "vendor/one", model: "same-model", usage: { input: 10, cost: { total: 0 } } } },
    { type: "message", timestamp: "2026-02-01T00:00:00Z", message: { role: "assistant", provider: "vendor/two", model: "same-model", usage: { input: 20 } } },
    { type: "message", timestamp: "2026-02-01T00:00:00Z", message: { role: "assistant", provider: "vendor/three", model: "same-model" } },
  ],
}]);

for (const style of ["original", "trae"]) {
  test(`${style}: health filters and report identity across desktop/mobile XL`, async ({ page }) => {
    await page.addInitScript(style => {
      localStorage.setItem("pi-ui-style", style);
      localStorage.setItem("pi-skin", "trae");
      localStorage.setItem("pi-font-size", "xlarge");
    }, style);
    await page.route("**/api/provider-health", route => route.fulfill({ json: {
      checkedAt: "2026-09-05T00:00:00Z", summary: { ready: 1, total: 1, warning: 0, invalid: 0, needsAuth: 0 },
      coverage: { credentialReadiness: "checked", localCatalog: "checked", quotaAndBilling: "not_checked", upstreamAvailability: "not_checked" },
      providers: [{ id: "vendor/long-provider-id-that-must-remain-readable", name: "Fixture vendor", status: "ready", authType: "oauth", authSource: "OAuth", storedCredential: true, modelCount: 1, availableModelCount: 1 }],
    } }));
    await page.route("**/api/sessions/analytics", route => route.fulfill({ json: report }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MAIN);
    await expect(page.locator("html")).toHaveAttribute("data-font-size", "xlarge");
    await expect.poll(() => page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--font-scale").trim())).toBe("1.3");
    await expect(page.getByText("專案架構分析").first()).toBeVisible();
    await page.getByRole("button", { name: /^Models/ }).first().click();
    await page.getByTestId("provider-health-nav").click();
    const health = page.getByTestId("provider-health");
    await expect(health).toContainText("No providers need attention");
    await expect(health.locator("article")).toHaveCount(0);
    const configured = health.getByRole("button", { name: "Configured", exact: true });
    await configured.focus(); await configured.press("Enter");
    await expect(configured).toHaveAttribute("aria-pressed", "true");
    await expect(health.locator("article")).toHaveCount(1);
    await expect(health.locator("article").getByText("OAuth", { exact: true })).toHaveCount(1);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(health.locator("code")).toHaveText("vendor/long-provider-id-that-must-remain-readable");
      await expect.poll(() => health.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await health.locator('article [data-status="ready"]').scrollIntoViewIfNeeded();
      await expect(health.locator('article [data-status="ready"]')).toBeInViewport();
      await health.screenshot({ path: test.info().outputPath(`health-${style}-${width}.png`) });
    }
    await page.getByRole("dialog", { name: "Models", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Token usage and cost report", exact: true }).first().click();
    const analytics = page.getByTestId("analytics-report");
    await expect(analytics).toContainText("All projects · All stored history");
    const details = analytics.locator("details");
    await expect(details).not.toHaveAttribute("open", "");
    await details.locator("summary").focus();
    await details.locator("summary").press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(details).toContainText("not a bill");
    await details.locator("summary").press("Enter");
    const modelRows = analytics.locator('[class*="tableRow"]').filter({ hasText: "same-model" });
    await expect(modelRows).toHaveCount(3);
    for (const [provider, state] of [["vendor/one", "recorded_zero"], ["vendor/two", "unknown"], ["vendor/three", "no_usage"]]) {
      const row = modelRows.filter({ hasText: provider });
      await expect(row.locator(`[data-cost-state="${state}"]`)).toBeVisible();
      if (state !== "recorded_zero") await expect(row).not.toContainText("$0.00");
    }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => analytics.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await modelRows.first().scrollIntoViewIfNeeded();
      await expect(modelRows.first()).toContainText("vendor/one");
      await page.screenshot({ path: test.info().outputPath(`analytics-${style}-${width}.png`) });
    }
  });
}

test("analytics API returns isolated persisted history with explicit scope", async ({ request }) => {
  const response = await request.get("/api/sessions/analytics");
  expect(response.ok()).toBe(true);
  const data = await response.json();
  expect(data.scope).toMatchObject({ projects: "all", history: "all_stored_branches", monthlyBasis: "message_timestamp_utc", skippedSessions: 0 });
  expect(data.summary.sessionCount).toBeGreaterThan(0);
  expect(data.summary.byModel[0]).toHaveProperty("provider");
  expect(data.summary.byModel[0]).toHaveProperty("modelId");
  expect(data.summary.coverage.recorded).toBeGreaterThan(0);
});
