import { test, expect, type Page } from "@playwright/test";

const MAIN = "/?session=aaaa1111-2222-3333-4444-555566667777";

async function openMain(page: Page) {
  await page.goto(MAIN);
  await expect(page.getByText("專案架構分析").first()).toBeVisible({ timeout: 20_000 });
}

test.describe("tGD artifacts panel", () => {
  test("lists the sibling <project>-tGD docs and opens one in the viewer", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "tGD artifacts" }).click();

    // Project-level documents and the feature directory
    await expect(page.getByText("CONTEXT.md")).toBeVisible();
    await expect(page.getByText("TRACKING-PLAN.md")).toBeVisible();
    // Feature names identify document groups without workflow progress.
    await expect(page.getByTitle("user-login", { exact: true })).toBeVisible();
    await expect(page.getByText("PRD.md")).toBeVisible();
    await expect(page.getByText("variant-a.html")).toBeVisible();
    // .scans infra dir is excluded
    await expect(page.getByText("index.txt")).toHaveCount(0);

    // Opening a doc renders it in the right panel
    await page.getByText("PRD.md").first().click();
    await expect(page.getByText("登入功能").first()).toBeVisible({ timeout: 10_000 });
  });

  test("Files view shows the whole tGD dir, including infra the Artifacts view hides", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "tGD artifacts" }).click();

    // Artifacts (curated) view excludes the .scans infra dir
    await expect(page.getByText(".scans")).toHaveCount(0);

    // Switch to Files → the entire tGD dir as a tree, nothing hidden
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByRole("button", { name: /\.scans/ })).toBeVisible();

    // Drill into a feature dir and open a doc from the tree
    await page.getByRole("button", { name: /^user-login/ }).first().click();
    await page.getByRole("button", { name: /PRD\.md/ }).first().click();
    await expect(page.getByText("登入功能").first()).toBeVisible({ timeout: 10_000 });
  });
});
